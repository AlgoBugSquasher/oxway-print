/**
 * Standalone print agent — runs ONLY on the kiosk's Raspberry Pi, as its own
 * process (see SETUP_PI.md for the systemd service), completely separate
 * from the website. The website can be hosted anywhere; this script just
 * needs outbound access to Supabase and a local CUPS printer.
 *
 * Loop: atomically claim the oldest ready-to-print job across the whole
 * kiosk queue — paid customer jobs and free staff prints share this one
 * queue with no priority, ordered strictly by when each became "paid," not
 * by who created it (see claimNextPaidJob's own docstring) — download its
 * print-ready PDF from Supabase Storage, submit to CUPS, wait for it to
 * leave the print queue, mark "printed", notify the customer, and log the
 * completed print for the admin dashboard. Repeats until the queue is
 * empty for this tick.
 *
 * Run with:  npx tsx print-agent/index.ts
 * (see package.json's "print-agent" script)
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";

// dotenv/config only loads a file literally named ".env" by default — this
// repo (matching Next.js convention) uses .env.local instead, so load that
// explicitly. Loads .env first (if present) then .env.local on top of it,
// same precedence Next.js itself uses.
loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), ".env.local"), override: true });

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AGENT_API_SECRET, BASE_URL, KIOSK_HEARTBEAT_INTERVAL_MS, KIOSK_ID, PRINT_AGENT_POLL_INTERVAL_MS } from "../lib/config";
import { failDanglingRunningCommand, finishKioskCommand } from "../lib/kiosk-commands";
import { recordAgentBoot, recordCompletedPrint, touchKioskHeartbeat } from "../lib/kiosk-stats";
import { enrichJobWithRazorpayPaymentDetails } from "../lib/payment-reconciliation";
import { prependBannerPage } from "../lib/print/banner";
import { cancelPrintJob, getCupsJobQueueState, submitPrintJob } from "../lib/print/cups";
import { expandCopies } from "../lib/print/pdf";
import { computeMinimumReadyAtMs, decidePrintWatchOutcome, needsWarmup } from "../lib/print/ready-timing";
import { physicalSheetsForJob } from "../lib/print/sheets";
import { attemptRefund } from "../lib/refund";
import { claimNextPaidJob, downloadJobPdf, updateJob, type PrintJobRecord } from "../lib/store";
import { getCurrentCommit, flushPendingResult, processKioskCommand } from "./kiosk-update";
import { readPendingCommandResult } from "./pending-command-result";
import { clearUpdateMarker, readUpdateMarker } from "./update-marker";

// Polls CUPS aggressively (every second) so the moment a job leaves the
// queue, the customer's Realtime-subscribed status page updates near-
// instantly instead of on the next multi-second poll tick.
const QUEUE_POLL_INTERVAL_MS = 1000;
// A job stuck in the CUPS queue this long is treated as failed rather than
// leaving the customer waiting forever — see failJob below.
const QUEUE_POLL_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * When the printer last actually finished a job, for needsWarmup's own
 * "has it been idle a while" check (see lib/print/ready-timing.ts) — module
 * state, not persisted, so it resets to null (and therefore always "needs
 * warmup") on every agent restart. That's deliberately conservative: a
 * restart tells us nothing about how long the printer was actually idle
 * before it.
 */
let lastJobFinishedAtMs: number | null = null;

/**
 * Pings the website's app/api/agent/notify whenever this job hits a
 * terminal state it might need a WhatsApp update for (printed, or
 * print_failed-after-a-successful-refund — see the two call sites below).
 * That route owns every actual decision (opted in? already sent? which
 * message?) and the real MSG91 credentials — this agent only ever needs to
 * know "something happened," never the notification business rules
 * themselves or any send-provider secrets.
 *
 * Best-effort and silent on missing config: AGENT_API_SECRET is optional
 * (WhatsApp notifications are an opt-in feature on top of an already-
 * working print flow), so a kiosk that hasn't set it up yet shouldn't log
 * a warning on every single job — same reasoning as OWNER_ALERT_PHONE
 * being optional elsewhere. A request that fails once it's actually
 * configured does get logged, since that's a real, actionable problem.
 */
async function notifyAgentTerminalState(jobId: string): Promise<void> {
  if (!AGENT_API_SECRET) return;
  try {
    const response = await fetch(`${BASE_URL}/api/agent/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_API_SECRET}` },
      body: JSON.stringify({ jobId }),
    });
    if (!response.ok) {
      console.error(`[print-agent] notify-terminal-state failed for job ${jobId}: HTTP ${response.status}`);
    }
  } catch (error) {
    // Must never crash the poll loop or mask the actual print/refund
    // outcome this is just reporting on — same reasoning as the
    // recordCompletedPrint/attemptRefund calls around this one.
    console.error(`[print-agent] notify-terminal-state request failed for job ${jobId}:`, error);
  }
}

/**
 * Prints one job that claimNextPaidJob (pollLoop below) has ALREADY
 * atomically claimed — its status is already 'printing' by the time this
 * runs, so unlike the old version of this function, there's no claim to
 * attempt (and no "someone else already got it" case to handle) here
 * anymore; that race is fully resolved before processJob is ever called.
 */
async function processJob(job: PrintJobRecord): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "oxway-print-"));
  const tempPdfPath = path.join(tempDir, `${job.id}.pdf`);
  // Declared outside the try block (not `const` inside it) so the catch
  // block below can still see whatever value it had at the point of
  // failure — undefined if the job never even reached CUPS, or the real id
  // if it did, in which case failJob needs it to actually cancel the job.
  let cupsJobId: string | undefined;

  try {
    console.log(`[print-agent] Printing job ${job.id} (${job.fileName})...`);
    let pdfBytes = await downloadJobPdf(job.pdfStoragePath);
    // Copies are baked directly into the PDF (copy 1's pages, then copy
    // 2's, etc.) rather than left to CUPS's own -n/collate handling — see
    // expandCopies' own docstring for why — so the single banner page
    // prepended next lands once at the very front of the whole job, ahead
    // of every copy, not once per copy.
    pdfBytes = await expandCopies(pdfBytes, job.settings.copies);
    if (job.includeBannerPage) {
      // The UPI transaction id is usually already saved by the time a job
      // reaches printing (see reconcilePendingPayment's own enrichment
      // call) — this is only a second, best-effort try for the case it
      // genuinely wasn't settled at Razorpay yet back then. Explicitly
      // skipped for a staff job (payment_method === "staff") even though
      // enrichJobWithRazorpayPaymentDetails would itself safely no-op for
      // one anyway (no paymentId/providerMeta.paymentRef ever gets set) —
      // never worth a real network round trip to Razorpay for a job that
      // was never a Razorpay payment to begin with.
      if (job.paymentMethod !== "staff" && job.provider === "razorpay" && !job.upiTxnId) {
        job = await enrichJobWithRazorpayPaymentDetails(job);
      }
      pdfBytes = await prependBannerPage(pdfBytes, job);
    }
    await writeFile(tempPdfPath, pdfBytes);

    cupsJobId = await submitPrintJob(tempPdfPath, job.settings);
    const spooledAtMs = Date.now();
    await updateJob(job.id, { cupsJobId, spooledAt: new Date(spooledAtMs).toISOString() });
    console.log(`[print-agent] Submitted to CUPS as ${cupsJobId}, watching queue...`);

    // claimed_at is stamped by claim_next_paid_job() itself (see that RPC),
    // so it's already on `job` by the time processJob ever runs — falling
    // back to "now" only guards against a job claimed before this column
    // existed, which should never actually happen in practice.
    const claimedAtMs = job.claimedAt ? new Date(job.claimedAt).getTime() : spooledAtMs;
    const warmupNeeded = needsWarmup(claimedAtMs, lastJobFinishedAtMs);

    await watchUntilPrinted(job, cupsJobId, { spooledAtMs, warmupNeeded });
  } catch (error) {
    await failJob(job, error instanceof Error ? error.message : "Unknown printing error.", cupsJobId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Shared terminal-failure path for both a thrown exception (processJob's
 * catch block) and a stuck/errored CUPS queue (watchUntilPrinted below) —
 * one place that marks the job print_failed and attempts the ROADMAP.md §10
 * auto-refund, so the two failure sources can never drift out of sync with
 * each other.
 *
 * Cancels the actual CUPS job first, when one was ever submitted — a real,
 * confirmed bug: without this, a stuck/errored job left sitting in CUPS's
 * queue could still get physically printed later (e.g. a disabled queue
 * getting re-enabled after its timeout), well after the customer had
 * already been refunded for it. `cupsJobId` is undefined only when the
 * failure happened before `lp` ever ran (e.g. the PDF download itself
 * failed) — nothing to cancel in that case.
 */
async function failJob(job: PrintJobRecord, reason: string, cupsJobId?: string): Promise<void> {
  console.error(`[print-agent] Job ${job.id} failed: ${reason}`);
  if (cupsJobId) await cancelPrintJob(cupsJobId);
  await updateJob(job.id, { status: "print_failed", error: reason });

  // Automatic, not waiting on staff to notice and click the admin panel's
  // refund button. Safe to call unconditionally: `job` here has never been
  // refunded yet, and attemptRefund's own already-refunded guard makes this
  // a no-op rather than a double refund if it's ever somehow called twice
  // for the same failure. A free staff print (payment_method === "staff")
  // never reaches Razorpay/Cashfree at all here — attemptRefund's own first
  // check skips straight to the "staff_job" branch below — see that
  // function's own comment for why.
  try {
    const result = await attemptRefund(job);
    if (result.ok) {
      console.log(`[print-agent] Auto-refunded job ${job.id}: ${result.refundId}`);
      // Only on a genuine refund success — see notifyPrintFailedRefunded's
      // own docstring for why a failed refund must never produce a message
      // claiming one happened.
      await notifyAgentTerminalState(job.id);
    } else if (result.reason === "no_captured_payment") {
      console.warn(`[print-agent] Could not auto-refund job ${job.id}: no captured payment reference.`);
    } else if (result.reason === "staff_job") {
      console.log(`[print-agent] Job ${job.id} was a free staff print — no refund needed.`);
    }
  } catch (refundError) {
    // A failed refund attempt must never crash the poll loop or mask the
    // print_failed status update above — staff can still refund manually
    // from the admin panel if this keeps failing.
    console.error(`[print-agent] Auto-refund failed for job ${job.id}:`, refundError);
  }
}

/**
 * Watches a submitted CUPS job until it's genuinely done — "genuinely" per
 * decidePrintWatchOutcome in lib/print/ready-timing.ts, which requires BOTH
 * CUPS (+printer-idle, see getCupsJobQueueState) reporting the job
 * completed AND the minimum-print-time floor to have elapsed, so "ready"
 * can never fire before the printer could plausibly have actually finished.
 * A CUPS error always wins immediately, floor or no floor — a paper jam
 * doesn't get more plausible by waiting it out.
 */
async function watchUntilPrinted(
  job: PrintJobRecord,
  cupsJobId: string,
  stageTiming: { spooledAtMs: number; warmupNeeded: boolean },
): Promise<void> {
  const physicalSheets = physicalSheetsForJob(job);
  const minimumReadyAtMs = computeMinimumReadyAtMs(stageTiming.spooledAtMs, physicalSheets, stageTiming.warmupNeeded);
  const deadlineMs = Date.now() + QUEUE_POLL_TIMEOUT_MS;
  // Set once, the first tick CUPS+the printer report the job done — even if
  // the floor hasn't elapsed yet, so the persisted timestamp reflects when
  // the printer actually finished, not when the floor let "printed" fire.
  let printerIdleAtMs: number | null = null;

  for (;;) {
    await sleep(QUEUE_POLL_INTERVAL_MS);
    const cupsState = await getCupsJobQueueState(cupsJobId);

    if (cupsState === "completed" && printerIdleAtMs === null) {
      printerIdleAtMs = Date.now();
      await updateJob(job.id, { printerIdleAt: new Date(printerIdleAtMs).toISOString() });
    }

    const outcome = decidePrintWatchOutcome({ cupsState, nowMs: Date.now(), minimumReadyAtMs, deadlineMs });

    if (outcome.kind === "error") {
      await failJob(job, `CUPS reported job ${cupsJobId} as stopped/held/errored.`, cupsJobId);
      return;
    }

    if (outcome.kind === "timeout") {
      // Still "active" (or "completed" but the floor itself never cleared
      // in time, which would mean the floor's own estimate is wildly off)
      // after the full timeout — stuck rather than genuinely erroring, but
      // the customer can't be left waiting forever either way.
      await failJob(job, `Job ${cupsJobId} was still queued after ${QUEUE_POLL_TIMEOUT_MS / 1000}s — treating as stuck.`, cupsJobId);
      return;
    }

    if (outcome.kind === "wait") continue;

    // outcome.kind === "ready"
    const readyAtMs = Date.now();
    await updateJob(job.id, { status: "printed", readyAt: new Date(readyAtMs).toISOString() });
    lastJobFinishedAtMs = readyAtMs;
    console.log(
      `[print-agent] Job ${job.id} printed. ` +
        `claim->spool ${stageDurationSeconds(job.claimedAt, stageTiming.spooledAtMs)}s, ` +
        `spool->printer-idle ${stageDurationSeconds(stageTiming.spooledAtMs, printerIdleAtMs)}s, ` +
        `printer-idle->ready ${stageDurationSeconds(printerIdleAtMs, readyAtMs)}s.`,
    );

    await notifyAgentTerminalState(job.id);

    await recordCompletedPrint(job.kioskId, {
      pagesPrinted: physicalSheets,
      // A free staff print's own totalPrice is always 0 (see
      // createStaffPrintJob) — waivedAmount is what recordCompletedPrint
      // actually accumulates into free_print_waived_amount for one.
      amount: job.isFree ? (job.waivedAmount ?? 0) : job.totalPrice,
      colorMode: job.settings.isColor,
      isFree: job.isFree,
    });
    return;
  }
}

/** Formats one stage's duration for the log line in watchUntilPrinted — accepts either endpoint as an ISO string (claimedAt) or an already-resolved ms timestamp, and reports "?" rather than throwing if either end is missing (e.g. printerIdleAtMs can still be null at timeout/error, though this is only ever called on the success path). */
function stageDurationSeconds(start: string | number | null | undefined, end: string | number | null | undefined): string {
  if (start == null || end == null) return "?";
  const startMs = typeof start === "string" ? new Date(start).getTime() : start;
  const endMs = typeof end === "string" ? new Date(end).getTime() : end;
  return ((endMs - startMs) / 1000).toFixed(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves whatever an `update` command left behind from a previous boot —
 * see print-agent/boot-guard.ts for the full rollback design this is one
 * half of. Called once, after this process has already proven itself by
 * completing a full poll cycle without throwing (not immediately on
 * startup): boot-guard is watching this same marker file to decide whether
 * to roll back, and clearing it too early would let it stop watching before
 * a crash moments into startup (e.g. inside recordAgentBoot or the first
 * listPaidJobs call) ever gets a chance to happen.
 */
async function confirmBootIfPending(): Promise<void> {
  const marker = readUpdateMarker();
  if (!marker) return;

  if (marker.status === "verifying") {
    await finishKioskCommand(marker.commandId, "done", `Updated successfully to ${getCurrentCommit().slice(0, 7)}.`);
    console.log(`[print-agent] Update ${marker.commandId} confirmed healthy.`);
  } else if (marker.status === "rolled_back") {
    await finishKioskCommand(marker.commandId, "failed", `New version failed to start — rolled back to ${marker.previousCommit.slice(0, 7)}.`);
    console.log(`[print-agent] Update ${marker.commandId} reported as failed — this boot is running the rolled-back code.`);
  }
  clearUpdateMarker();
}

async function pollLoop(): Promise<void> {
  console.log(`[print-agent] Kiosk "${KIOSK_ID}" watching for paid jobs every ${PRINT_AGENT_POLL_INTERVAL_MS}ms...`);
  let hasConfirmedBoot = false;
  for (;;) {
    try {
      // Drains the whole queue for this tick, one atomic claim at a time —
      // claimNextPaidJob picks (and claims, in the same Postgres statement)
      // whichever ready job has the oldest queue_time across BOTH paid
      // customer jobs and free staff prints, so this loop processes them in
      // one single, unbiased FIFO order rather than listing then claiming
      // each individually (see that function's own docstring for why that
      // distinction matters under concurrency).
      for (;;) {
        const job = await claimNextPaidJob(KIOSK_ID);
        if (!job) break;
        await processJob(job);
      }
      // Only reached once the paid-job queue for this tick is fully
      // drained — the single-threaded await chain above is exactly what
      // guarantees nothing is mid-claim or mid-print the moment this runs,
      // satisfying "update only when idle" without a separate busy flag.
      await processKioskCommand(KIOSK_ID);
      if (!hasConfirmedBoot) {
        await confirmBootIfPending();
        hasConfirmedBoot = true; // Only set once the above actually succeeds — a thrown error here should retry next tick, not strand the marker unresolved forever.
      }
    } catch (error) {
      console.error("[print-agent] Poll cycle failed:", error);
    }
    await sleep(PRINT_AGENT_POLL_INTERVAL_MS);
  }
}

// Independent of the job-polling loop above (ROADMAP.md #8) — this keeps
// beating even when there's nothing to print, which is the whole point:
// job-polling alone would let an idle-but-healthy kiosk look "stale."
function startHeartbeat(): void {
  void touchKioskHeartbeat(KIOSK_ID);
  setInterval(() => void touchKioskHeartbeat(KIOSK_ID), KIOSK_HEARTBEAT_INTERVAL_MS);
}

/**
 * One-time boot bookkeeping, run before either loop starts:
 *   - Report this kiosk's current commit, every boot, not just after an
 *     update (see lib/kiosk-stats.ts's recordAgentBoot) — the admin panel's
 *     "agent version" needs this from the very first boot ever, regardless
 *     of whether a remote command was ever involved.
 *   - Flush a result kiosk-update.ts couldn't report last time because the
 *     Pi's own network happened to be down at that exact moment (see
 *     reportOutcome in that file) — done BEFORE the dangling-row cleanup
 *     below, so a real "failed: npm install errored" result gets first
 *     crack at landing rather than being overwritten by that cleanup's
 *     generic "interrupted" message.
 *   - Clean up a kiosk_commands row still stuck "running" after the above
 *     two — from a boot that ended some other way entirely (e.g. the Pi
 *     lost power mid-update, before anything got a chance to write
 *     anything) — excluding whatever command this boot's own update-marker
 *     or just-flushed pending result already accounted for, so the cleanup
 *     paths can never race over the same row.
 */
async function reportBoot(): Promise<void> {
  const commit = getCurrentCommit();
  await recordAgentBoot(KIOSK_ID, commit);
  await flushPendingResult();
  const marker = readUpdateMarker();
  const stillPendingResult = readPendingCommandResult();
  await failDanglingRunningCommand(KIOSK_ID, marker?.commandId ?? stillPendingResult?.commandId ?? null);
}

void reportBoot().then(() => {
  startHeartbeat();
  pollLoop();
});
