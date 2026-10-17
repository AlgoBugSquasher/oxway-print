import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two real bugs were fixed in this file while porting to v2.5 (see its own
// comments): recordCompletedPrint hardcoded "oxway_01" regardless of which
// kiosk actually printed, and the cartridge low-supply alert only fired at
// 100% (too late to act) while tray fired at 90%. Both are exactly the kind
// of thing that looks fine in a manual single-kiosk test and only shows up
// as a real gap once a second kiosk exists or a cartridge actually runs dry
// — these tests assert the fix, not just that the function runs.

interface MockKioskRow {
  tray_pages: number;
  cartridge_pages: number;
  tray_max_pages: number;
  cartridge_max_pages: number;
  total_revenue: number;
  total_lifetime_prints: number;
  free_print_count: number;
  free_print_pages: number;
  free_print_waived_amount: number;
}

const mock = vi.hoisted(() => ({
  kioskRowsById: new Map<string, MockKioskRow>(),
  selectedIds: [] as string[],
  updateCalls: [] as { id: string; patch: Record<string, unknown> }[],
  printOrdersInsertCalls: [] as Record<string, unknown>[],
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "print_orders") {
        return { insert: (row: Record<string, unknown>) => { mock.printOrdersInsertCalls.push(row); return Promise.resolve({ data: null, error: null }); } };
      }
      // table === "kiosk_status"
      return {
        select: () => ({
          eq: (_column: string, id: string) => ({
            single: () => {
              mock.selectedIds.push(id);
              const row = mock.kioskRowsById.get(id);
              return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } });
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_column: string, id: string) => {
            mock.updateCalls.push({ id, patch });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  }),
}));

function seedKiosk(id: string, overrides: Partial<MockKioskRow> = {}) {
  mock.kioskRowsById.set(id, {
    tray_pages: 0,
    cartridge_pages: 0,
    tray_max_pages: 150,
    cartridge_max_pages: 1500,
    total_revenue: 0,
    total_lifetime_prints: 0,
    free_print_count: 0,
    free_print_pages: 0,
    free_print_waived_amount: 0,
    ...overrides,
  });
}

describe("recordCompletedPrint", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mock.kioskRowsById.clear();
    mock.selectedIds = [];
    mock.updateCalls = [];
    mock.printOrdersInsertCalls = [];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("reads and updates the kiosk it was actually told about, not a hardcoded 'oxway_01'", async () => {
    seedKiosk("oxway_02", { tray_pages: 10 });
    const { recordCompletedPrint } = await import("./kiosk-stats");

    await recordCompletedPrint("oxway_02", { pagesPrinted: 5, amount: 10, colorMode: false });

    expect(mock.selectedIds).toEqual(["oxway_02"]);
    expect(mock.updateCalls).toHaveLength(1);
    expect(mock.updateCalls[0].id).toBe("oxway_02");
  });

  it("returns null without updating anything when the given kiosk id has no row", async () => {
    // No kiosk seeded at all.
    const { recordCompletedPrint } = await import("./kiosk-stats");
    const result = await recordCompletedPrint("oxway_99", { pagesPrinted: 5, amount: 10, colorMode: false });
    expect(result).toBeNull();
    expect(mock.updateCalls).toHaveLength(0);
  });

  it("alerts on the print that crosses 90% cartridge capacity — the exact threshold that used to only fire at 100%", async () => {
    // 1349/1500 = 89.9%; +1 page crosses to 1350/1500 = 90.0%.
    seedKiosk("oxway_01", { cartridge_pages: 1349, tray_pages: 0 });
    const { recordCompletedPrint } = await import("./kiosk-stats");

    await recordCompletedPrint("oxway_01", { pagesPrinted: 1, amount: 2, colorMode: false });

    const cartridgeAlerts = warnSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes("cartridge"));
    expect(cartridgeAlerts).toHaveLength(1);
  });

  it("does NOT alert again on a later print once already above threshold — the debounce, not just the crossing", async () => {
    // Already at 95% before this print — well past the crossing point.
    seedKiosk("oxway_01", { cartridge_pages: 1425, cartridge_max_pages: 1500 });
    const { recordCompletedPrint } = await import("./kiosk-stats");

    await recordCompletedPrint("oxway_01", { pagesPrinted: 1, amount: 2, colorMode: false });

    const cartridgeAlerts = warnSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes("cartridge"));
    expect(cartridgeAlerts).toHaveLength(0);
  });

  it("computes the tray threshold as a percentage of tray_max_pages, not a fixed sheet count", async () => {
    // A small kiosk with tray_max_pages=10 (e.g. just refilled to a partial
    // amount by staff) should alert well below any hardcoded 135-ish number.
    seedKiosk("oxway_01", { tray_pages: 8, tray_max_pages: 10 });
    const { recordCompletedPrint } = await import("./kiosk-stats");

    await recordCompletedPrint("oxway_01", { pagesPrinted: 1, amount: 2, colorMode: false });

    const trayAlerts = warnSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes("paper tray"));
    expect(trayAlerts).toHaveLength(1);
  });

  // Free staff prints (ROADMAP-style staff-print feature, #13): excluded
  // from revenue, tracked in their own running counters instead, still
  // counted toward physical paper/toner consumption like any other print.
  describe("isFree", () => {
    it("bumps free_print_* instead of total_revenue, using `waivedAmount` as the waived value", async () => {
      seedKiosk("oxway_01", { total_revenue: 50, free_print_count: 2, free_print_pages: 8, free_print_waived_amount: 16 });
      const { recordCompletedPrint } = await import("./kiosk-stats");

      await recordCompletedPrint("oxway_01", { pagesPrinted: 3, amount: 0, waivedAmount: 6, colorMode: false, isFree: true });

      const patch = mock.updateCalls[0].patch;
      expect(patch.total_revenue).toBeUndefined(); // never touched for a free print
      expect(patch.free_print_count).toBe(3);
      expect(patch.free_print_pages).toBe(11);
      expect(patch.free_print_waived_amount).toBe(22);
    });

    it("still increments physical paper/toner consumption for a free print — the paper was real even if the print wasn't billed", async () => {
      seedKiosk("oxway_01", { tray_pages: 10, cartridge_pages: 10, total_lifetime_prints: 20 });
      const { recordCompletedPrint } = await import("./kiosk-stats");

      await recordCompletedPrint("oxway_01", { pagesPrinted: 4, amount: 8, colorMode: false, isFree: true });

      const patch = mock.updateCalls[0].patch;
      expect(patch.tray_pages).toBe(14);
      expect(patch.cartridge_pages).toBe(14);
      expect(patch.total_lifetime_prints).toBe(24);
    });

    it("still inserts into print_orders for a free print, but flagged is_free with a null amount and the waived_amount set — the durable ledger get_kiosk_period_breakdown reads has to know about it even though it's not revenue", async () => {
      seedKiosk("oxway_01");
      const { recordCompletedPrint } = await import("./kiosk-stats");

      await recordCompletedPrint("oxway_01", { pagesPrinted: 1, amount: 0, waivedAmount: 2, colorMode: false, isFree: true });

      expect(mock.printOrdersInsertCalls).toHaveLength(1);
      const row = mock.printOrdersInsertCalls[0];
      expect(row.is_free).toBe(true);
      expect(row.amount).toBe(0);
      expect(row.waived_amount).toBe(2);
    });

    it("inserts into print_orders for a normal (non-free) print with is_free/is_reprint false and no waived_amount", async () => {
      seedKiosk("oxway_01");
      const { recordCompletedPrint } = await import("./kiosk-stats");

      await recordCompletedPrint("oxway_01", { pagesPrinted: 1, amount: 2, colorMode: false });

      expect(mock.printOrdersInsertCalls).toHaveLength(1);
      const row = mock.printOrdersInsertCalls[0];
      expect(row.is_free).toBe(false);
      expect(row.is_reprint).toBe(false);
      expect(row.waived_amount).toBeNull();
      const patch = mock.updateCalls[0].patch;
      expect(patch.total_revenue).toBe(2);
      expect(patch.free_print_count).toBeUndefined();
    });

    it("inserts into print_orders for a reprint flagged is_reprint, with amount 0 and no revenue/free-print bookkeeping", async () => {
      seedKiosk("oxway_01", { total_revenue: 50, free_print_count: 1 });
      const { recordCompletedPrint } = await import("./kiosk-stats");

      await recordCompletedPrint("oxway_01", { pagesPrinted: 2, amount: 0, colorMode: false, isReprint: true });

      expect(mock.printOrdersInsertCalls).toHaveLength(1);
      const row = mock.printOrdersInsertCalls[0];
      expect(row.is_reprint).toBe(true);
      expect(row.amount).toBe(0);
      const patch = mock.updateCalls[0].patch;
      expect(patch.total_revenue).toBeUndefined();
      expect(patch.free_print_count).toBeUndefined();
    });
  });
});
