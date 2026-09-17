import type { PrintJobRecord } from "../store";

/**
 * Physical sheets a job actually consumes — banner included, once per copy
 * (see ROADMAP.md #5: CUPS duplicates the whole submitted PDF per copy, so
 * the banner correctly lands on every physical copy). Shared by
 * print-agent/index.ts (feeding the paper/toner counters) and lib/eta.ts
 * (ROADMAP.md #3), so both agree on what a job actually costs.
 */
export function physicalSheetsForJob(job: Pick<PrintJobRecord, "selectedPages" | "settings" | "includeBannerPage">): number {
  const sheetsPerCopy = Math.ceil(job.selectedPages.length / job.settings.pagesPerSheet) + (job.includeBannerPage ? 1 : 0);
  return sheetsPerCopy * job.settings.copies;
}
