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
import { KIOSK_HEARTBEAT_INTERVAL_MS, KIOSK_ID, PRINT_AGENT_POLL_INTERVAL_MS } from "../lib/config";
import { recordCompletedPrint, touchKioskHeartbeat } from "../lib/kiosk-stats";
// ROADMAP.md §2 (notifications) is disabled for v2.5 — see the call site
// below for why, and lib/payment-reconciliation.ts for the other trigger.
// import { notifyPrintCompleted } from "../lib/notify";
import { prependBannerPage } from "../lib/print/banner";
import { isJobStillQueued, submitPrintJob } from "../lib/print/cups";
import { physicalSheetsForJob } from "../lib/print/sheets";
import { attemptRefund } from "../lib/refund";
import { claimJobForPrinting, downloadJobPdf, listPaidJobs, updateJob, type PrintJobRecord } from "../lib/store";

const QUEUE_POLL_INTERVAL_MS = 3000;
const QUEUE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function processJob(job: PrintJobRecord): Promise<void> {
  const claimed = await claimJobForPrinting(job.id);
  if (!claimed) return; // Someone/something else already claimed it.

  const tempDir = await mkdtemp(path.join(tmpdir(), "oxway-print-"));
  const tempPdfPath = path.join(tempDir, `${job.id}.pdf`);

  try {
    console.log(`[print-agent] Printing job ${job.id} (${job.fileName})...`);
    let pdfBytes = await downloadJobPdf(job.pdfStoragePath);
    if (job.includeBannerPage) {
      pdfBytes = await prependBannerPage(pdfBytes, job);
    }
    await writeFile(tempPdfPath, pdfBytes);

    const cupsJobId = await submitPrintJob(tempPdfPath, job.settings);
    await updateJob(job.id, { cupsJobId });
    console.log(`[print-agent] Submitted to CUPS as ${cupsJobId}, watching queue...`);

    await watchUntilPrinted(job, cupsJobId);
  } catch (error) {
    console.error(`[print-agent] Job ${job.id} failed:`, error);
    await updateJob(job.id, {
      status: "print_failed",
      error: error instanceof Error ? error.message : "Unknown printing error.",
    });

    // ROADMAP.md §10 — automatic, not waiting on staff to notice and click
    // the admin panel's refund button. Safe to call unconditionally: `job`
    // here is the pre-claim record (never refunded yet), and attemptRefund's
    // own already-refunded guard makes this a no-op rather than a double
    // refund if it's ever somehow called twice for the same failure.
    try {
      const result = await attemptRefund(job);
      if (result.ok) {
        console.log(`[print-agent] Auto-refunded job ${job.id}: ${result.refundId}`);
      } else if (result.reason === "no_captured_payment") {
        console.warn(`[print-agent] Could not auto-refund job ${job.id}: no captured payment reference.`);
      }
    } catch (refundError) {
      // A failed refund attempt must never crash the poll loop or mask the
      // print_failed status update above — staff can still refund manually
      // from the admin panel if this keeps failing.
      console.error(`[print-agent] Auto-refund failed for job ${job.id}:`, refundError);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function watchUntilPrinted(job: PrintJobRecord, cupsJobId: string): Promise<void> {
  const deadline = Date.now() + QUEUE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(QUEUE_POLL_INTERVAL_MS);
    const stillQueued = await isJobStillQueued(cupsJobId);
    if (!stillQueued) {
      await updateJob(job.id, { status: "printed" });
      console.log(`[print-agent] Job ${job.id} printed.`);

      // Disabled for v2.5 — the customer already has their ticket code
      // (ROADMAP.md §21-23) instead of a "ready for pickup" text.
      // try {
      //   await notifyPrintCompleted(job);
      // } catch (notifyError) {
      //   console.error(`[print-agent] notifyPrintCompleted failed for job ${job.id}:`, notifyError);
      // }

      await recordCompletedPrint(job.kioskId, {
        pagesPrinted: physicalSheetsForJob(job),
        amount: job.totalPrice,
        colorMode: job.settings.isColor,
      });
      return;
    }
  }
  // Left claimed/"printing" — the job is still in the CUPS queue after the
  // timeout. Check `lpstat -o` on the kiosk directly.
  console.warn(`[print-agent] Job ${job.id} (CUPS ${cupsJobId}) still queued after timeout.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoop(): Promise<void> {
  console.log(`[print-agent] Kiosk "${KIOSK_ID}" watching for paid jobs every ${PRINT_AGENT_POLL_INTERVAL_MS}ms...`);
  for (;;) {
    try {
      const paidJobs = await listPaidJobs(KIOSK_ID);
      for (const job of paidJobs) {
        await processJob(job);
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

startHeartbeat();
pollLoop();
