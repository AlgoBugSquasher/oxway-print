import { describe, expect, it } from "vitest";
import { formatBucketLabel, summarizePeriodBreakdown } from "./period-stats";
import type { PeriodBreakdownRow } from "./types";

function bucket(overrides: Partial<PeriodBreakdownRow>): PeriodBreakdownRow {
  return {
    bucket_start: "2026-10-14T00:00:00+05:30",
    revenue: 0,
    refund_amount: 0,
    refund_count: 0,
    pages_printed: 0,
    prints_completed: 0,
    free_print_count: 0,
    free_print_pages: 0,
    free_print_waived_amount: 0,
    reprint_count: 0,
    reprint_pages: 0,
    separators_printed: 0,
    covers_printed: 0,
    ...overrides,
  };
}

describe("summarizePeriodBreakdown", () => {
  it("sums totals (never averages) across every bucket", () => {
    const totals = summarizePeriodBreakdown([
      bucket({ revenue: 100, pages_printed: 5, prints_completed: 1 }),
      bucket({ revenue: 50, pages_printed: 3, prints_completed: 1 }),
    ]);
    expect(totals.revenue).toBe(150);
    expect(totals.pagesPrinted).toBe(8);
    expect(totals.printsCompleted).toBe(2);
  });

  it("carries the RPC's own revenue (already net of refunds processed in-period) and the refund amount separately", () => {
    // get_kiosk_period_breakdown() nets revenue against refund_events in SQL
    // before returning the row — this helper just sums what it's given.
    const totals = summarizePeriodBreakdown([bucket({ revenue: 150, refund_amount: 50, refund_count: 1 })]);
    expect(totals.revenue).toBe(150);
    expect(totals.refundAmount).toBe(50);
    expect(totals.refundCount).toBe(1);
  });

  it("keeps reprints out of revenue and pages_printed, counted in their own fields", () => {
    const totals = summarizePeriodBreakdown([bucket({ revenue: 80, pages_printed: 4, reprint_count: 1, reprint_pages: 3 })]);
    expect(totals.revenue).toBe(80);
    expect(totals.pagesPrinted).toBe(4);
    expect(totals.reprintCount).toBe(1);
    expect(totals.reprintPages).toBe(3);
  });

  it("keeps free staff prints out of revenue but counted in their own pages/count fields", () => {
    const totals = summarizePeriodBreakdown([bucket({ revenue: 80, pages_printed: 4, free_print_count: 1, free_print_pages: 2, free_print_waived_amount: 20 })]);
    expect(totals.revenue).toBe(80);
    expect(totals.pagesPrinted).toBe(4);
    expect(totals.freePrintCount).toBe(1);
    expect(totals.freePrintPages).toBe(2);
    expect(totals.freePrintWaivedAmount).toBe(20);
  });

  it("keeps money fields null for staff (masked by the RPC) instead of summing nulls into a misleading zero", () => {
    const totals = summarizePeriodBreakdown([
      bucket({ revenue: null, refund_amount: null, refund_count: null, free_print_waived_amount: null, pages_printed: 10 }),
      bucket({ revenue: null, refund_amount: null, refund_count: null, free_print_waived_amount: null, pages_printed: 5 }),
    ]);
    expect(totals.revenue).toBeNull();
    expect(totals.refundAmount).toBeNull();
    expect(totals.refundCount).toBeNull();
    expect(totals.freePrintWaivedAmount).toBeNull();
    expect(totals.pagesPrinted).toBe(15);
  });

  it("defaults every total to zero (not null) when there are no buckets at all yet", () => {
    const totals = summarizePeriodBreakdown([]);
    expect(totals.pagesPrinted).toBe(0);
    expect(totals.printsCompleted).toBe(0);
    expect(totals.freePrintCount).toBe(0);
  });
});

describe("formatBucketLabel", () => {
  it("labels an hourly Today bucket by its Kolkata hour, regardless of the host's own timezone", () => {
    // 18:30 UTC = 00:00 the next day in IST — the hour label must read as
    // midnight IST, not 6:30pm, which is exactly the "job just before/after
    // midnight IST" boundary case this whole feature is built around.
    const label = formatBucketLabel("2026-10-13T18:30:00Z", "today");
    expect(label.toLowerCase()).toContain("12");
    expect(label.toLowerCase()).toContain("am");
  });

  it("labels a Year bucket by month name", () => {
    expect(formatBucketLabel("2026-03-01T00:00:00+05:30", "year")).toBe("Mar");
  });

  it("labels a Week/Month bucket by weekday and day number", () => {
    const label = formatBucketLabel("2026-10-14T00:00:00+05:30", "week");
    expect(label).toMatch(/\d+/);
  });
});
