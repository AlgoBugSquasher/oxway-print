import { describe, expect, it } from "vitest";
import { computePaperEstimate, computeTonerEstimate, LOW_SUPPLY_REMAINING_RATIO } from "./supply-estimate";
import type { SupplyStatusRow } from "./types";

/**
 * Covers the TESTS section of the Problem 2 task directly: no-baseline
 * state, after setting a baseline, after printing, after a refill
 * (baseline resets), and out-of-range values — for both paper (counts
 * DOWN from quantity) and toner (counts UP from starting_pages toward
 * cartridge_max_pages).
 */

function row(overrides: Partial<SupplyStatusRow> = {}): SupplyStatusRow {
  return {
    cartridge_max_pages: 1500,
    has_paper_baseline: false,
    paper_quantity: null,
    paper_consumed_since: null,
    paper_refilled_at: null,
    paper_refilled_by: null,
    has_toner_baseline: false,
    toner_starting_pages: null,
    toner_consumed_since: null,
    toner_refilled_at: null,
    toner_refilled_by: null,
    ...overrides,
  };
}

describe("computePaperEstimate", () => {
  it("reports not_set_up when no refill event has ever been recorded — the exact symptom reported: a kiosk with no baseline showing a meaningless percentage", () => {
    const estimate = computePaperEstimate(row());
    expect(estimate.status).toBe("not_set_up");
    expect(estimate.remaining).toBeNull();
    expect(estimate.percent).toBeNull();
  });

  it("after setting a baseline with nothing printed since, reports the full quantity at 100%", () => {
    const estimate = computePaperEstimate(row({ has_paper_baseline: true, paper_quantity: 140, paper_consumed_since: 0, paper_refilled_at: "2026-10-14T05:00:00Z", paper_refilled_by: "user-1" }));
    expect(estimate.status).toBe("ok");
    expect(estimate.remaining).toBe(140);
    expect(estimate.percent).toBe(100);
    expect(estimate.lastRefillByUserId).toBe("user-1");
  });

  it("after printing some jobs, remaining and percent drop by exactly what was consumed", () => {
    const estimate = computePaperEstimate(row({ has_paper_baseline: true, paper_quantity: 140, paper_consumed_since: 40 }));
    expect(estimate.remaining).toBe(100);
    expect(estimate.percent).toBeCloseTo((100 / 140) * 100);
    expect(estimate.status).toBe("ok");
  });

  it("drops to the low-supply status once remaining falls to the configured ratio or below", () => {
    const thresholdConsumed = 140 * (1 - LOW_SUPPLY_REMAINING_RATIO);
    const estimate = computePaperEstimate(row({ has_paper_baseline: true, paper_quantity: 140, paper_consumed_since: thresholdConsumed }));
    expect(estimate.status).toBe("low");
  });

  it("after a refill, the baseline resets — a fresh event with its own quantity and zero consumed-since replaces the old one entirely", () => {
    // get_kiosk_supply_status only ever looks at the LATEST refill event
    // (order by at desc limit 1) and sums consumption only since it — this
    // test asserts the pure math side of that: a new, smaller or larger
    // quantity with 0 consumed-since reads as a fresh 100%, regardless of
    // how depleted the previous baseline was.
    const estimate = computePaperEstimate(row({ has_paper_baseline: true, paper_quantity: 150, paper_consumed_since: 0, paper_refilled_at: "2026-10-14T09:00:00Z" }));
    expect(estimate.remaining).toBe(150);
    expect(estimate.percent).toBe(100);
  });

  it("goes to needs_refill_update, never a percentage above 100 or below 0, when consumption exceeds the baseline", () => {
    const estimate = computePaperEstimate(row({ has_paper_baseline: true, paper_quantity: 100, paper_consumed_since: 130 }));
    expect(estimate.status).toBe("needs_refill_update");
    expect(estimate.remaining).toBeNull();
    expect(estimate.percent).toBeNull();
  });
});

describe("computeTonerEstimate", () => {
  it("reports not_set_up when no refill event has ever been recorded", () => {
    const estimate = computeTonerEstimate(row());
    expect(estimate.status).toBe("not_set_up");
  });

  it("after setting a baseline of 0 (a genuinely fresh cartridge), reports the full yield at 100%", () => {
    const estimate = computeTonerEstimate(row({ has_toner_baseline: true, toner_starting_pages: 0, toner_consumed_since: 0, cartridge_max_pages: 1500 }));
    expect(estimate.remaining).toBe(1500);
    expect(estimate.percent).toBe(100);
    expect(estimate.status).toBe("ok");
  });

  it("supports registering an already-partially-used cartridge (starting_pages > 0)", () => {
    const estimate = computeTonerEstimate(row({ has_toner_baseline: true, toner_starting_pages: 500, toner_consumed_since: 0, cartridge_max_pages: 1500 }));
    expect(estimate.remaining).toBe(1000);
  });

  it("after printing, remaining counts down toward the yield ceiling", () => {
    const estimate = computeTonerEstimate(row({ has_toner_baseline: true, toner_starting_pages: 0, toner_consumed_since: 1400, cartridge_max_pages: 1500 }));
    expect(estimate.remaining).toBe(100);
    expect(estimate.status).toBe("low");
  });

  it("after a refill (toner replaced), the baseline resets to the new starting_pages with zero consumed-since", () => {
    const estimate = computeTonerEstimate(row({ has_toner_baseline: true, toner_starting_pages: 0, toner_consumed_since: 0, cartridge_max_pages: 1500, toner_refilled_at: "2026-10-14T10:00:00Z" }));
    expect(estimate.remaining).toBe(1500);
  });

  it("goes to needs_refill_update, never a percentage above 100 or below 0, when usage exceeds the configured yield", () => {
    const estimate = computeTonerEstimate(row({ has_toner_baseline: true, toner_starting_pages: 1000, toner_consumed_since: 600, cartridge_max_pages: 1500 }));
    expect(estimate.status).toBe("needs_refill_update");
    expect(estimate.remaining).toBeNull();
    expect(estimate.percent).toBeNull();
  });
});
