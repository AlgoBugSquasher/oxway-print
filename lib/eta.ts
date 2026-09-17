import { physicalSheetsForJob } from "./print/sheets";
import { listJobsAheadInQueue, type PrintJobRecord } from "./store";

/**
 * ~18 ppm rated print speed for the Samsung ML-1866W (see ROADMAP.md's
 * hardware note under §20) — 60 seconds / 18 sheets per minute.
 */
const SECONDS_PER_SHEET = 60 / 18;

/**
 * Start-simple ETA (ROADMAP.md #3): fixed per-sheet time times this job's
 * own sheet count, plus the same for every job still ahead of it in the
 * paid/printing queue at the same kiosk — using each ahead job's actual
 * sheet count rather than an assumed average, since listJobsAheadInQueue
 * already has to fetch those rows to count them.
 *
 * Deliberately not calibrated from historical print durations yet — the
 * roadmap explicitly defers that until there's real usage data to
 * calibrate against, rather than guessing at a correction factor now.
 */
export async function estimateMinutesUntilReady(job: PrintJobRecord): Promise<number> {
  const jobsAhead = await listJobsAheadInQueue(job);
  const totalSheets = physicalSheetsForJob(job) + jobsAhead.reduce((sum, aheadJob) => sum + physicalSheetsForJob(aheadJob), 0);
  return Math.max(1, Math.ceil((totalSheets * SECONDS_PER_SHEET) / 60));
}
