/**
 * Standalone print agent — runs ONLY on the kiosk's Raspberry Pi, as its own
 * process (see SETUP_PI.md for the systemd service), completely separate
 * from the website. The website can be hosted anywhere; this script just
 * needs outbound access to Supabase and a local CUPS printer.
 *
 * Loop: poll Supabase for jobs the website has marked "paid" -> claim one
 * atomically (so a second agent instance, if you ever ran one, can't double
 * print it) -> download its print-ready PDF from Supabase Storage -> submit
 * to CUPS -> wait for it to leave the print queue -> mark "printed" and log
 * the completed print for the admin dashboard.
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
import { PRINT_AGENT_POLL_INTERVAL_MS } from "../lib/config";
import { claimJobForPrinting, downloadJobPdf, listPaidJobs, updateJob, type PrintJobRecord } from "../lib/store";
import { submitPrintJob, isJobStillQueued } from "../lib/print/cups";
import { recordCompletedPrint } from "../lib/kiosk-stats";

const QUEUE_POLL_INTERVAL_MS = 3000;
const QUEUE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function processJob(job: PrintJobRecord): Promise<void> {
  const claimed = await claimJobForPrinting(job.id);
  if (!claimed) return; // Someone/something else already claimed it.

  const tempDir = await mkdtemp(path.join(tmpdir(), "oxway-print-"));
  const tempPdfPath = path.join(tempDir, `${job.id}.pdf`);

  try {
    console.log(`[print-agent] Printing job ${job.id} (${job.fileName})...`);
    const pdfBytes = await downloadJobPdf(job.pdfStoragePath);
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

      const sheetsPrinted = Math.ceil(job.selectedPages.length / job.settings.pagesPerSheet) * job.settings.copies;
      await recordCompletedPrint({
        pagesPrinted: sheetsPrinted,
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
  console.log(`[print-agent] Watching for paid jobs every ${PRINT_AGENT_POLL_INTERVAL_MS}ms...`);
  for (;;) {
    try {
      const paidJobs = await listPaidJobs();
      for (const job of paidJobs) {
        await processJob(job);
      }
    } catch (error) {
      console.error("[print-agent] Poll cycle failed:", error);
    }
    await sleep(PRINT_AGENT_POLL_INTERVAL_MS);
  }
}

pollLoop();
