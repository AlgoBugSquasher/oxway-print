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
import { clearKioskPrintBlocked, getKioskSeparatorSettings, recordAgentBoot, recordCompletedPrint, setKioskPrintBlocked, touchKioskHeartbeat } from "../lib/kiosk-stats";
import { enrichJobWithRazorpayPaymentDetails } from "../lib/payment-reconciliation";
import { prependBannerPage } from "../lib/print/banner";
import { cancelPrintJob, getCupsJobQueueState, isCupsJobKnown, isPrinterAcceptingNewJobs, submitPrintJob } from "../lib/print/cups";
import { expandCopies } from "../lib/print/pdf";
import { computeMinimumReadyAtMs, decidePrintWatchOutcome, needsWarmup, READY_TIMING_CONFIG } from "../lib/print/ready-timing";
import { decideRestartOutcome } from "../lib/print/restart-reconciliation";
import { prependSeparatorPage } from "../lib/print/separator";
import { physicalSheetsForJob } from "../lib/print/sheets";
import { decideSheetKind } from "../lib/print/sheet-kind";
import { claimNextPaidJob, downloadJobPdf, failPrintingJob, getJob, isTrayLikelyOccupied, listInFlightJobsForKiosk, markJobInterrupted, updateJob, type PrintJobRecord } from "../lib/store";
import { getCurrentCommit, flushPendingResult, processKioskCommand } from "./kiosk-update";
import { readPendingCommandResult } from "./pending-command-result";
import { clearUpdateMarker, readUpdateMarker } from "./update-marker";

// Polls CUPS aggressively (every second) so the moment a job leaves the
// queue, the customer's Realtime-subscribed status page updates near-
// instantly instead of on the next multi-second poll tick.
const QUEUE_POLL_INTERVAL_MS = 1000;
// A job stuck in the CUPS queue this long is treated as failed rather than
// leaving the customer waiting forever — see finalizeFailure below. Time
// spent genuinely print_blocked (see BLOCKED_RETRY_LIMIT_MS) never counts
// against this — see decidePrintWatchOutcome's own blockedElapsedMs.
const QUEUE_POLL_TIMEOUT_MS = 2 * 60 * 1000;
// How long a RECOVERABLE printer problem is tolerated before finally
// giving up — see lib/print/ready-timing.ts's own config for the full
// reasoning behind the value and why it's deliberately separate from
// QUEUE_POLL_TIMEOUT_MS above.
const BLOCKED_RETRY_LIMIT_MS = READY_TIMING_CONFIG.blockedRetryLimitSeconds * 1000;

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
 * Pings the website's app/api/agent/notify whenever this job reaches the
 * one terminal state it might need a WhatsApp update for: printed (see the
 * call site below). A print_failed job is no longer notified from here at
 * all — refunds are now an owner-reviewed admin action, not something that
 * resolves itself the instant a job fails, so there's no longer an
 * immediate "refunded" outcome for this agent to report at that moment.
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
    // Must never crash the poll loop or mask the actual print outcome this
    // is just reporting on — same reasoning as the recordCompletedPrint
    // call around this one.
    console.error(`[print-agent] notify-terminal-state request failed for job ${jobId}:`, error);
  }
}

/** Fire-and-forget: asks the website to re-check low-supply alerts (lib/alerts/low-supply.ts) right after a completed print, same AGENT_API_SECRET pattern as notifyAgentTerminalState above. */
async function checkLowSupplyAfterPrint(kioskId: string): Promise<void> {
  if (!AGENT_API_SECRET) return;
  try {
    const response = await fetch(`${BASE_URL}/api/agent/check-low-supply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_API_SECRET}` },
      body: JSON.stringify({ kioskId }),
    });
    if (!response.ok) console.error(`[print-agent] check-low-supply failed for kiosk ${kioskId}: HTTP ${response.status}`);
  } catch (error) {
    console.error(`[print-agent] check-low-supply request failed for kiosk ${kioskId}:`, error);
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

  try {
    console.log(`[print-agent] Printing job ${job.id} (${job.fileName})...`);
    let pdfBytes = await downloadJobPdf(job.pdfStoragePath);
    pdfBytes = await expandCopies(pdfBytes, job.settings.copies);

    const separatorSettings = await getKioskSeparatorSettings(job.kioskId);
    const trayLikelyOccupied = await isTrayLikelyOccupied(job.kioskId, new Date(), separatorSettings);
    const sheetKind = decideSheetKind({
      pickupMode: job.pickupMode ?? "here",
      separatorMode: separatorSettings.separatorMode,
      forceCoverSheet: job.forceCoverSheet ?? false,
      trayLikelyOccupied,
      physicalSheets: physicalSheetsForJob(job),
      largeJobPages: separatorSettings.largeJobPages,
    });

    if (sheetKind === "cover") {
      if (job.paymentMethod !== "staff" && job.paymentMethod !== "reprint" && job.provider === "razorpay" && !job.upiTxnId) {
        job = await enrichJobWithRazorpayPaymentDetails(job);
      }
      pdfBytes = await prependBannerPage(pdfBytes, job);
    } else if (sheetKind === "separator") {
      pdfBytes = await prependSeparatorPage(pdfBytes, job);
    }

    await updateJob(job.id, { sheetKind });
    job.sheetKind = sheetKind;
    await writeFile(tempPdfPath, pdfBytes);

    await printWithRetries(job, tempPdfPath);
  } catch (error) {
    // Everything up to writeFile above happens before any CUPS job exists
    // at all (nothing to cancel) and before any blocked/retry logic is
    // even relevant — a failed download, PDF composition, or disk write
    // is a software-level problem, not a printer-readiness one, so this
    // goes straight to the ordinary immediate failure.
    await finalizeFailure(job, error instanceof Error ? error.message : "Unknown printing error.", undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Marks a job print_blocked (and the whole kiosk along with it, for the
 * website/kiosk-display to pick up — requirement: "block new checkout"),
 * logging only on the FIRST tick a given blocked spell is seen so a
 * problem that persists across many poll ticks doesn't spam the log once
 * per second. Not atomically guarded (unlike finalizeFailure's
 * failPrintingJob below) — this only ever runs from inside the one
 * in-process loop already watching this exact job, so there's no
 * concurrent writer to race against, the same reasoning the ORIGINAL
 * code's plain updateJob calls (spooledAt, printerIdleAt) already relied on.
 */
async function markJobBlocked(job: PrintJobRecord, reason: string, isNewlyBlocked: boolean): Promise<void> {
  if (isNewlyBlocked) console.warn(`[print-agent] Job ${job.id} blocked: ${reason}`);
  await updateJob(job.id, { status: "print_blocked", blockedReason: reason });
  await setKioskPrintBlocked(job.kioskId, reason);
}

/** The opposite of markJobBlocked — the printer's ready again (or a fresh job is about to start and found nothing wrong), so the job goes back to 'printing' and the kiosk-wide flag clears. */
async function clearJobBlocked(job: PrintJobRecord): Promise<void> {
  console.log(`[print-agent] Job ${job.id} unblocked, resuming.`);
  await updateJob(job.id, { status: "printing", blockedReason: null });
  await clearKioskPrintBlocked(job.kioskId);
}

/**
 * Shared terminal-failure path for every genuinely unrecoverable outcome:
 * a thrown exception before CUPS was ever involved (processJob's catch
 * block), an unrecoverable CUPS error, the ordinary stuck-job timeout, or
 * a recoverable problem that outlasted BLOCKED_RETRY_LIMIT_MS.
 *
 * Cancels the actual CUPS job first, when one was ever submitted — a real,
 * confirmed bug: without this, a stuck/errored job left sitting in CUPS's
 * queue could still get physically printed later (e.g. a disabled queue
 * getting re-enabled after its timeout), well after staff had already
 * approved a refund for it. `cupsJobId` is undefined only when the failure
 * happened before `lp` ever ran — nothing to cancel in that case.
 *
 * Uses failPrintingJob (lib/store.ts), NOT a plain updateJob — this is the
 * one call in this entire file that re-checks the job's CURRENT status in
 * the database before writing, atomically, and refuses to touch it if it's
 * already 'printed' (or already resolved some other way). That's the
 * direct fix for "a job can be both failed and printed": the exact race
 * this guards against is the SAME physically-buffered job (common for this
 * printer's USB/SPL driver — see lib/print/cups.ts's own reliability note)
 * finishing printing on its own at almost the same instant this function
 * is about to give up on it.
 *
 * No longer attempts a refund itself — a database trigger
 * (set_print_job_refund_pending, see supabase/schema.sql) sets this job's
 * refund_status to 'pending' automatically the moment the status update
 * below lands (for any job that was actually paid — never for a free
 * staff print), and an owner reviews/approves it from the admin Refunds
 * page instead (lib/refund.ts's attemptRefund). Refunds are never
 * instant/automatic anymore.
 */
async function finalizeFailure(job: PrintJobRecord, reason: string, cupsJobId?: string): Promise<void> {
  console.error(`[print-agent] Job ${job.id} failed: ${reason}`);
  if (cupsJobId) await cancelPrintJob(cupsJobId);

  const updated = await failPrintingJob(job.id, reason);
  if (!updated) {
    console.warn(
      `[print-agent] Job ${job.id} was no longer printing/print_blocked by the time of this failure (likely already printed) — ` +
      "leaving its current state untouched rather than overwriting it."
    );
  }
  // The kiosk itself is no longer blocked on THIS job either way, once
  // resolved — safe to clear unconditionally even if this particular
  // failure was never actually a "blocked" one (clearing an already-null
  // flag is a no-op).
  await clearKioskPrintBlocked(job.kioskId);
}

/**
 * Waits for the printer to report itself ready to accept a job AT ALL
 * (the coarse, "before printing" pre-flight check — see
 * lib/print/cups.ts's isPrinterAcceptingNewJobs for exactly what this can
 * and can't detect) before ever calling `lp` for this job. A kiosk already
 * known broken from a PREVIOUS job's own failure never gets a fresh job
 * spooled into it needlessly — the SAME generous BLOCKED_RETRY_LIMIT_MS
 * budget governs this phase too, carried forward into the post-submission
 * watch loop if the printer becomes ready before it runs out.
 *
 * Returns the ok-with-accumulated-blocked-time shape (0 if never blocked
 * here) so printWithRetries can carry that forward into
 * decidePrintWatchOutcome's own blockedElapsedMs — time spent waiting here
 * must never count against the ordinary post-submission stuck-job timeout
 * either, same reasoning that timeout-extension already has everywhere
 * else. Returns ok: false only once this phase itself gave up (and already
 * called finalizeFailure) — the caller must not do anything further.
 */
async function waitForPrinterReadyBeforeSubmitting(job: PrintJobRecord): Promise<{ ok: true; blockedElapsedMs: number } | { ok: false }> {
  let blockedSinceMs: number | null = null;
  let isBlocked = false;

  for (;;) {
    if (await isPrinterAcceptingNewJobs()) {
      if (isBlocked) await clearJobBlocked(job);
      return { ok: true, blockedElapsedMs: blockedSinceMs !== null ? Date.now() - blockedSinceMs : 0 };
    }

    const nowMs = Date.now();
    if (blockedSinceMs === null) blockedSinceMs = nowMs;
    await markJobBlocked(job, "Printer is not currently accepting jobs.", !isBlocked);
    isBlocked = true;

    if (nowMs - blockedSinceMs >= BLOCKED_RETRY_LIMIT_MS) {
      await finalizeFailure(job, `Printer was not accepting jobs for over ${BLOCKED_RETRY_LIMIT_MS / 1000}s.`, undefined);
      return { ok: false };
    }
    await sleep(QUEUE_POLL_INTERVAL_MS);
  }
}

/**
 * Submits the job once pre-flight readiness looks fine, then watches it
 * until it's genuinely done — "genuinely" per decidePrintWatchOutcome in
 * lib/print/ready-timing.ts, which requires BOTH CUPS (+printer-idle, see
 * getCupsJobQueueState) reporting the job completed AND the minimum-
 * print-time floor to have elapsed, so "ready" can never fire before the
 * printer could plausibly have actually finished. An unrecoverable CUPS
 * error always wins immediately, floor or no floor — a paper jam doesn't
 * get more plausible by waiting it out.
 *
 * A RECOVERABLE problem (print-agent/index.ts's own getCupsJobQueueState
 * classification) never cancels the live CUPS job and never fails the
 * job — it marks it print_blocked and keeps polling the SAME submitted
 * job, deliberately. This is the actual fix for "a job can be both failed
 * and printed": the old behavior canceled the CUPS job the instant a
 * paper-out condition was seen, but this printer's own driver had often
 * already buffered the full job internally by then, so the physical
 * printer went on to finish it anyway once paper was loaded — well after
 * it had already been marked print_failed (and, previously, auto-
 * refunded). Not canceling means that SAME buffered job is exactly what
 * resumes once the printer's ready again, and this loop's own continued
 * polling is what notices and marks it 'printed' correctly, with no
 * resubmission ever needed. See lib/print/cups.ts's reliability note for
 * how confident this app actually is in the "blocked" classification on
 * the real Samsung ML-1866W.
 */
async function printWithRetries(job: PrintJobRecord, tempPdfPath: string): Promise<void> {
  const preflight = await waitForPrinterReadyBeforeSubmitting(job);
  if (!preflight.ok) return;

  // Requirement: "before any retry... re-check the job's current status in
  // the database" — before ever calling `lp`, confirm via a fresh read
  // that nothing else (a concurrent admin cancel, a reprint, anything)
  // already moved this job away from printing/print_blocked while the
  // pre-flight wait above was running.
  const current = await getJob(job.id);
  if (!current || (current.status !== "printing" && current.status !== "print_blocked")) {
    console.log(`[print-agent] Job ${job.id} is no longer printing/print_blocked (now "${current?.status ?? "missing"}") — leaving it alone, never submitting.`);
    return;
  }

  const cupsJobId = await submitPrintJob(tempPdfPath, job.settings);
  const spooledAtMs = Date.now();
  await updateJob(job.id, { status: "printing", cupsJobId, spooledAt: new Date(spooledAtMs).toISOString() });
  console.log(`[print-agent] Submitted to CUPS as ${cupsJobId}, watching queue...`);

  // claimed_at is stamped by claim_next_paid_job() itself (see that RPC),
  // so it's already on `job` by the time processJob ever runs — falling
  // back to "now" only guards against a job claimed before this column
  // existed, which should never actually happen in practice.
  const claimedAtMs = job.claimedAt ? new Date(job.claimedAt).getTime() : spooledAtMs;
  const warmupNeeded = needsWarmup(claimedAtMs, lastJobFinishedAtMs);

  await watchUntilPrinted(job, cupsJobId, { spooledAtMs, warmupNeeded, initialBlockedElapsedMs: preflight.blockedElapsedMs });
}

async function watchUntilPrinted(
  job: PrintJobRecord,
  cupsJobId: string,
  stageTiming: { spooledAtMs: number; warmupNeeded: boolean; initialBlockedElapsedMs: number },
): Promise<void> {
  const physicalSheets = physicalSheetsForJob(job);
  const minimumReadyAtMs = computeMinimumReadyAtMs(stageTiming.spooledAtMs, physicalSheets, stageTiming.warmupNeeded);
  const deadlineMs = Date.now() + QUEUE_POLL_TIMEOUT_MS;
  // Set once, the first tick CUPS+the printer report the job done — even if
  // the floor hasn't elapsed yet, so the persisted timestamp reflects when
  // the printer actually finished, not when the floor let "printed" fire.
  let printerIdleAtMs: number | null = null;

  // Total time this job has spent blocked so far (carried over from the
  // pre-submission pre-flight phase, if any) plus every completed blocked
  // SPAN seen below — this is what extends deadlineMs so legitimate
  // waiting-on-paper time never counts against the ordinary stuck-job
  // timeout. blockedSinceMs tracks only the CURRENT, still-open span (null
  // when not currently blocked).
  let blockedElapsedMs = stageTiming.initialBlockedElapsedMs;
  let blockedSinceMs: number | null = null;
  let isBlocked = false;

  for (;;) {
    await sleep(QUEUE_POLL_INTERVAL_MS);
    const cupsState = await getCupsJobQueueState(cupsJobId);

    if (cupsState.kind === "blocked") {
      if (blockedSinceMs === null) blockedSinceMs = Date.now();
      await markJobBlocked(job, cupsState.reason, !isBlocked);
      isBlocked = true;
    } else if (isBlocked) {
      await clearJobBlocked(job);
      isBlocked = false;
      if (blockedSinceMs !== null) {
        blockedElapsedMs += Date.now() - blockedSinceMs;
        blockedSinceMs = null;
      }
    }

    if (cupsState.kind === "completed" && printerIdleAtMs === null) {
      printerIdleAtMs = Date.now();
      await updateJob(job.id, { printerIdleAt: new Date(printerIdleAtMs).toISOString() });
    }

    const outcome = decidePrintWatchOutcome({
      cupsState, nowMs: Date.now(), minimumReadyAtMs, deadlineMs,
      blockedElapsedMs, blockedSinceMs, blockedLimitMs: BLOCKED_RETRY_LIMIT_MS,
    });

    if (outcome.kind === "blocked" || outcome.kind === "wait") continue;

    if (outcome.kind === "error") {
      await finalizeFailure(job, `CUPS reported job ${cupsJobId} as errored: ${outcome.reason}.`, cupsJobId);
      return;
    }

    if (outcome.kind === "blocked_timeout") {
      await finalizeFailure(job, `Printer problem ("${outcome.reason}") persisted for over ${BLOCKED_RETRY_LIMIT_MS / 1000}s.`, cupsJobId);
      return;
    }

    if (outcome.kind === "timeout") {
      // Still "active" (or "completed" but the floor itself never cleared
      // in time, which would mean the floor's own estimate is wildly off)
      // after the full timeout — stuck rather than genuinely erroring, but
      // the customer can't be left waiting forever either way.
      await finalizeFailure(job, `Job ${cupsJobId} was still queued after ${QUEUE_POLL_TIMEOUT_MS / 1000}s — treating as stuck.`, cupsJobId);
      return;
    }

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
      // A free staff print's own totalPrice and a reprint's own totalPrice
      // are both always 0 (see createStaffPrintJob) — real revenue is 0 for
      // either, so `amount` only ever carries a real paying customer's
      // price. waivedAmount carries what a free print WOULD have cost,
      // used only for free_print_waived_amount/print_orders.waived_amount.
      amount: job.isFree || job.originalJobId !== undefined ? 0 : job.totalPrice,
      waivedAmount: job.isFree ? (job.waivedAmount ?? 0) : undefined,
      colorMode: job.settings.isColor,
      isFree: job.isFree,
      isReprint: job.originalJobId !== undefined,
      sheetKind: job.sheetKind,
    });

    await checkLowSupplyAfterPrint(job.kioskId);

    if (job.originalJobId) {
      // This job itself printing is what set_original_job_refund_not_needed
      // (the status update just above) already resolved the ORIGINAL job's
      // own pending refund, if it had one — nothing further to do here.
      console.log(`[print-agent] Job ${job.id} was a reprint of ${job.originalJobId} — that job's refund (if pending) is now marked not_needed.`);
    }
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
 * Runs once, before the normal poll loop starts — reconciles every job
 * THIS kiosk had still "printing"/"print_blocked" the moment the agent's
 * previous process stopped (a crash, a manual restart, a Pi reboot — this
 * can't tell which, and doesn't need to). Requirement: "a restart never
 * fails or refunds a job."
 *
 * For each one: a job with no cupsJobId yet never reached `lp` before the
 * crash, so CUPS never had it — straight to 'interrupted', nothing to
 * check. A job that WAS submitted asks isCupsJobKnown (lib/print/cups.ts)
 * the deliberately narrow "does CUPS have any memory of this job id at
 * all" question (not the richer getCupsJobQueueState, which is the wrong
 * tool for THIS specific question at boot — see that function's own
 * reliability note for why): known -> let it finish, by reattaching the
 * exact same watchUntilPrinted loop a job this process just submitted
 * itself would get, so it resolves to 'printed' or genuinely fails
 * exactly as correctly as it always would; unknown -> 'interrupted', with
 * a reason, never print_failed and never auto-reprinted.
 *
 * Deliberately fire-and-forget for the "reattach" case (never awaited) so
 * a job that's going to take several more minutes to finish printing
 * doesn't delay this kiosk's own poll loop from starting — reattached
 * watchers run concurrently with it, touching only their own job's row,
 * same as a job this process submits itself already does.
 */
async function reconcileInFlightJobsOnBoot(): Promise<void> {
  const inFlightJobs = await listInFlightJobsForKiosk(KIOSK_ID);
  for (const job of inFlightJobs) {
    const cupsKnowsJob = job.cupsJobId ? await isCupsJobKnown(job.cupsJobId) : false;
    const outcome = decideRestartOutcome({ cupsJobId: job.cupsJobId, cupsKnowsJob });

    if (outcome.kind === "interrupted") {
      console.warn(`[print-agent] Job ${job.id} was still "${job.status}" at boot — ${outcome.reason}`);
      await markJobInterrupted(job.id, outcome.reason);
      continue;
    }

    // outcome.kind === "reattach" — job.cupsJobId is guaranteed defined
    // here (decideRestartOutcome only ever reaches "reattach" when it is).
    console.log(`[print-agent] Reattaching to job ${job.id} (CUPS ${job.cupsJobId}) — still known to CUPS after restart, letting it finish.`);
    const spooledAtMs = job.spooledAt ? new Date(job.spooledAt).getTime() : Date.now();
    void watchUntilPrinted(job, job.cupsJobId as string, { spooledAtMs, warmupNeeded: needsWarmup(spooledAtMs, lastJobFinishedAtMs), initialBlockedElapsedMs: 0 })
      .catch((error) => console.error(`[print-agent] Reattached watch for job ${job.id} failed unexpectedly:`, error));
  }
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

void reportBoot()
  .then(() => reconcileInFlightJobsOnBoot())
  .then(() => {
    startHeartbeat();
    pollLoop();
  });
