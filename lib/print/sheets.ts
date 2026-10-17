import type { PrintJobRecord } from "../store";

export function physicalSheetsForJob(job: Pick<PrintJobRecord, "selectedPages" | "settings" | "includeBannerPage" | "sheetKind">): number {
  const contentSheets = Math.ceil(job.selectedPages.length / job.settings.pagesPerSheet) * job.settings.copies;
  const extraSheet = job.sheetKind !== undefined ? job.sheetKind !== "none" : job.includeBannerPage;
  return contentSheets + (extraSheet ? 1 : 0);
}
