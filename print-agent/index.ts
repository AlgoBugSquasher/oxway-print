/**
 * Standalone print agent — runs ONLY on the kiosk's Raspberry Pi, as its own
 * process (see SETUP_PI.md for the systemd service), completely separate
 * from the website. The website can be hosted anywhere; this script just
 * needs outbound access to Supabase and a local CUPS printer.
 *
 * Loop: poll Supabase for jobs the website has marked "paid" -> claim one
 * atomically (so a second agent instance, if you ever ran one, can't double
 * print it) -> download its print-ready PDF from Supabase Storage -> submit
 * to CUPS -> wait for it to leave the print queue -> mark "printed", notify
 * the customer, and log the completed print for the admin dashboard.
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
import { prependBannerPage } from "../lib/print/banner";
import { cancelPrintJob, getCupsJobQueueState, submitPrintJob } from "../lib/print/cups";
import { physicalSheetsForJob } from "../lib/print/sheets";
import { attemptRefund } from "../lib/refund";
import { claimJobForPrinting, downloadJobPdf, listPaidJobs, updateJob, type PrintJobRecord } from "../lib/store";
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

async function processJob(job: PrintJobRecord): Promise<void> {
  const claimed = await claimJobForPrinting(job.id);
  if (!claimed) return; // Someone/something else already claimed it.

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
    if (job.includeBannerPage) {
      pdfBytes = await prependBannerPage(pdfBytes, job);
    }
    await writeFile(tempPdfPath, pdfBytes);

    cupsJobId = await submitPrintJob(tempPdfPath, job.settings);
    await updateJob(job.id, { cupsJobId });
    console.log(`[print-agent] Submitted to CUPS as ${cupsJobId}, watching queue...`);

    await watchUntilPrinted(job, cupsJobId);
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
  // refund button. Safe to call unconditionally: `job` here is the pre-claim
  // record (never refunded yet), and attemptRefund's own already-refunded
  // guard makes this a no-op rather than a double refund if it's ever
  // somehow called twice for the same failure.
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
    }
  } catch (refundError) {
    // A failed refund attempt must never crash the poll loop or mask the
    // print_failed status update above — staff can still refund manually
    // from the admin panel if this keeps failing.
    console.error(`[print-agent] Auto-refund failed for job ${job.id}:`, refundError);
  }
}

async function watchUntilPrinted(job: PrintJobRecord, cupsJobId: string): Promise<void> {
  const deadline = Date.now() + QUEUE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(QUEUE_POLL_INTERVAL_MS);
    const state = await getCupsJobQueueState(cupsJobId);

    if (state === "completed") {
      await updateJob(job.id, { status: "printed" });
      console.log(`[print-agent] Job ${job.id} printed.`);

      await notifyAgentTerminalState(job.id);

      await recordCompletedPrint(job.kioskId, {
        pagesPrinted: physicalSheetsForJob(job),
        amount: job.totalPrice,
        colorMode: job.settings.isColor,
      });
      return;
    }

    if (state === "error") {
      await failJob(job, `CUPS reported job ${cupsJobId} as stopped/held/errored.`, cupsJobId);
      return;
    }
  }
  // Still "active" after the full timeout — stuck rather than genuinely
  // erroring, but the customer can't be left waiting forever either way.
  await failJob(job, `Job ${cupsJobId} was still queued after ${QUEUE_POLL_TIMEOUT_MS / 1000}s — treating as stuck.`, cupsJobId);
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
      const paidJobs = await listPaidJobs(KIOSK_ID);
      for (const job of paidJobs) {
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
