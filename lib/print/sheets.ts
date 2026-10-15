import type { PrintJobRecord } from "../store";

/**
 * Physical sheets a job actually consumes — content sheets once per copy,
 * plus the banner exactly once for the whole job (not once per copy — see
 * prependBannerPage in lib/print/banner.ts and expandCopies in
 * lib/print/pdf.ts, which together put exactly one banner page at the very
 * front of the submitted PDF regardless of how many copies it contains).
 * Shared by print-agent/index.ts (feeding the paper/toner counters) and
 * lib/eta.ts (ROADMAP.md #3), so both agree on what a job actually costs.
 */
export function physicalSheetsForJob(job: Pick<PrintJobRecord, "selectedPages" | "settings" | "includeBannerPage">): number {
  const contentSheets = Math.ceil(job.selectedPages.length / job.settings.pagesPerSheet) * job.settings.copies;
  return contentSheets + (job.includeBannerPage ? 1 : 0);
}
