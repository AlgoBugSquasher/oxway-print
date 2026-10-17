import type { OverviewPeriod, PeriodBreakdownRow } from "./types";

/**
 * Pure helpers over get_kiosk_period_breakdown's rows — no Supabase client,
 * no React, so these have plain unit tests. The RPC already did the
 * expensive part (scanning print_jobs once, in SQL, with database
 * aggregates); summing its handful of returned bucket rows (at most 31, for
 * Month) client-side is cheap and still satisfies "use database aggregates,
 * no loading all rows."
 */

export interface PeriodTotals {
  revenue: number | null;
  refundAmount: number | null;
  refundCount: number | null;
  pagesPrinted: number;
  printsCompleted: number;
  freePrintCount: number;
  freePrintPages: number;
  freePrintWaivedAmount: number | null;
  reprintCount: number;
  reprintPages: number;
  separatorsPrinted: number;
  coversPrinted: number;
}

/**
 * Sums every bucket into one set of totals. Money fields stay `null` if the
 * RPC returned them as null (staff) — summing nulls into 0 would silently
 * turn "unknown" into "zero," which is wrong for a value staff aren't
 * supposed to see at all. Every row is masked the same way (same caller,
 * same call), so checking the first row's revenue is enough to know whether
 * the whole set is masked.
 */
export function summarizePeriodBreakdown(rows: PeriodBreakdownRow[]): PeriodTotals {
  const moneyKnown = rows.length > 0 && rows[0].revenue !== null;
  return {
    revenue: moneyKnown ? rows.reduce((sum, row) => sum + (row.revenue ?? 0), 0) : null,
    refundAmount: moneyKnown ? rows.reduce((sum, row) => sum + (row.refund_amount ?? 0), 0) : null,
    refundCount: moneyKnown ? rows.reduce((sum, row) => sum + (row.refund_count ?? 0), 0) : null,
    pagesPrinted: rows.reduce((sum, row) => sum + row.pages_printed, 0),
    printsCompleted: rows.reduce((sum, row) => sum + row.prints_completed, 0),
    freePrintCount: rows.reduce((sum, row) => sum + row.free_print_count, 0),
    freePrintPages: rows.reduce((sum, row) => sum + row.free_print_pages, 0),
    freePrintWaivedAmount: moneyKnown ? rows.reduce((sum, row) => sum + (row.free_print_waived_amount ?? 0), 0) : null,
    reprintCount: rows.reduce((sum, row) => sum + row.reprint_count, 0),
    reprintPages: rows.reduce((sum, row) => sum + row.reprint_pages, 0),
    separatorsPrinted: rows.reduce((sum, row) => sum + row.separators_printed, 0),
    coversPrinted: rows.reduce((sum, row) => sum + row.covers_printed, 0),
  };
}

export const PERIOD_LABELS: Record<OverviewPeriod, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
  year: "This year",
};

/**
 * Formats one bucket's label for the mini per-day/hour/month breakdown,
 * always in Asia/Kolkata wall-clock time regardless of the viewer's own
 * browser timezone — the bucket boundaries themselves come from the RPC
 * already Kolkata-aligned, so the label has to agree with that or the UI
 * would show a bucket under the wrong hour/day to a non-IST viewer.
 */
export function formatBucketLabel(bucketStartIso: string, period: OverviewPeriod): string {
  const date = new Date(bucketStartIso);
  if (period === "today") {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: true }).format(date);
  }
  if (period === "year") {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", month: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric" }).format(date);
}
