import type { SupplyStatusRow } from "./types";

/**
 * Pure remaining/percent/status math over get_kiosk_supply_status's raw
 * inputs — no Supabase client, so this has a real unit test independent of
 * the database (per the task's TESTS section: no-baseline, after-baseline,
 * after-printing, after-a-refill, out-of-range all need to be exercisable
 * without hitting Postgres). The RPC's own job is just summing consumption
 * since the last refill event; everything below is pure arithmetic on
 * numbers it already computed.
 */

export type SupplyStatus = "not_set_up" | "ok" | "low" | "needs_refill_update";

export interface SupplyEstimate {
  status: SupplyStatus;
  /** Null when not_set_up (no baseline yet) or needs_refill_update (out of range — showing a number would be misleading). */
  remaining: number | null;
  /** 0-100, same null cases as `remaining`. */
  percent: number | null;
  lastRefillAt: string | null;
  lastRefillByUserId: string | null;
}

/**
 * Below this remaining fraction, show a low-supply warning — equivalent to
 * the old "consumed >= 90% of capacity" threshold kiosk-card.tsx used
 * before this feature existed, just expressed as "10% or less remaining"
 * since remaining-from-a-baseline (not consumed-against-a-fixed-capacity)
 * is what's actually tracked now.
 */
export const LOW_SUPPLY_REMAINING_RATIO = 0.1;

function estimateFromRemaining(remaining: number, denominator: number, lastRefillAt: string | null, lastRefillByUserId: string | null): SupplyEstimate {
  // The only way this estimate can be "out of range" — remaining can never
  // mathematically exceed its own denominator (percent can't go above
  // 100%), but consumption since the baseline can exceed what was loaded
  // (percent can go below 0%) if a refill was recorded late or consumption
  // was under-counted for some other reason.
  if (remaining < 0) {
    return { status: "needs_refill_update", remaining: null, percent: null, lastRefillAt, lastRefillByUserId };
  }
  const percent = denominator > 0 ? (remaining / denominator) * 100 : 0;
  const status: SupplyStatus = percent / 100 <= LOW_SUPPLY_REMAINING_RATIO ? "low" : "ok";
  return { status, remaining, percent, lastRefillAt, lastRefillByUserId };
}

/**
 * Paper counts DOWN from the baseline: `quantity` is how many sheets were
 * in the tray as of the last refill event, so remaining = quantity minus
 * whatever's printed since. The percentage denominator is that same
 * `quantity` — "100%" means "as much as was loaded," not a fixed tray
 * capacity the owner might not have filled all the way.
 */
export function computePaperEstimate(row: Pick<SupplyStatusRow, "has_paper_baseline" | "paper_quantity" | "paper_consumed_since" | "paper_refilled_at" | "paper_refilled_by">): SupplyEstimate {
  if (!row.has_paper_baseline || row.paper_quantity === null) {
    return { status: "not_set_up", remaining: null, percent: null, lastRefillAt: null, lastRefillByUserId: null };
  }
  const remaining = row.paper_quantity - (row.paper_consumed_since ?? 0);
  return estimateFromRemaining(remaining, row.paper_quantity, row.paper_refilled_at, row.paper_refilled_by);
}

/**
 * Toner counts UP from the baseline: `toner_starting_pages` is how many
 * pages the cartridge had already printed as of the last refill event, so
 * total used-so-far = that plus whatever's printed since, and remaining =
 * cartridge_max_pages (the configurable yield) minus that total. The
 * percentage denominator is cartridge_max_pages, not the starting pages.
 */
export function computeTonerEstimate(row: Pick<SupplyStatusRow, "cartridge_max_pages" | "has_toner_baseline" | "toner_starting_pages" | "toner_consumed_since" | "toner_refilled_at" | "toner_refilled_by">): SupplyEstimate {
  if (!row.has_toner_baseline || row.toner_starting_pages === null) {
    return { status: "not_set_up", remaining: null, percent: null, lastRefillAt: null, lastRefillByUserId: null };
  }
  const usedSoFar = row.toner_starting_pages + (row.toner_consumed_since ?? 0);
  const remaining = row.cartridge_max_pages - usedSoFar;
  return estimateFromRemaining(remaining, row.cartridge_max_pages, row.toner_refilled_at, row.toner_refilled_by);
}
