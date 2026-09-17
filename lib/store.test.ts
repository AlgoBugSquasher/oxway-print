import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsMatch } from "./store";

// Highest-risk logic per ROADMAP.md #14: the atomic UPDATE ... WHERE status = X
// guards (claimJobAsPaid, expireJobIfPending, claimJobForPrinting, deleteJob)
// are the entire mechanism preventing double-printing and duplicate
// notifications (ROADMAP.md §11). A refactor that silently drops the status
// check wouldn't fail typecheck or a happy-path manual test — it would only
// show up as a real double-print under concurrent load. These tests assert
// the actual query chain includes the guard, not just that the function
// compiles and returns *a* value.

/** Records every chained call so assertions can check exactly what query was built, then resolves like a real Supabase query when awaited. */
function createMockQueryBuilder(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const CHAIN_METHODS = ["from", "select", "update", "delete", "insert", "eq", "neq", "in", "lt", "lte", "gt", "gte", "order", "limit", "single", "maybeSingle"];
  const builder: Record<string, unknown> = { __calls: calls };
  for (const method of CHAIN_METHODS) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => resolve(result);
  return builder as { __calls: typeof calls } & Record<string, (...args: unknown[]) => unknown>;
}

const mockAdmin = vi.hoisted(() => ({
  current: null as ReturnType<typeof createMockQueryBuilder> | null,
  // Separate from `current` (the .from() query builder) since assignTicketNumber
  // goes through .rpc(), a different call shape entirely.
  rpcResult: null as { data: unknown; error: unknown } | null,
  rpcCalls: [] as { name: string; args: unknown }[],
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: () => mockAdmin.current,
    // deleteJob also removes the Storage object after a successful row
    // delete — stubbed as a no-op success so that path doesn't need its own
    // dedicated mock per test.
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    rpc: async (name: string, args: unknown) => {
      mockAdmin.rpcCalls.push({ name, args });
      return mockAdmin.rpcResult;
    },
  }),
}));

describe("settingsMatch", () => {
  const base = { copies: 1, layout: "portrait" as const, isColor: false, paperSize: "A4" as const, pagesPerSheet: 1 as const };

  it("matches identical settings", () => {
    expect(settingsMatch(base, { ...base })).toBe(true);
  });

  it("does not match when any field differs", () => {
    expect(settingsMatch(base, { ...base, copies: 2 })).toBe(false);
    expect(settingsMatch(base, { ...base, isColor: true })).toBe(false);
    expect(settingsMatch(base, { ...base, layout: "landscape" })).toBe(false);
  });

  it("is not fooled by key order — the exact bug a JSON.stringify comparison had", () => {
    // Same values, deliberately different construction order — this is what
    // a jsonb round-trip through Postgres can produce even for identical data.
    const reordered = { pagesPerSheet: 1 as const, paperSize: "A4" as const, isColor: false, layout: "portrait" as const, copies: 1 };
    expect(settingsMatch(base, reordered)).toBe(true);
  });
});

describe("atomic status-guarded store functions", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.current = null;
  });

  it("claimJobAsPaid guards on status = 'pending_payment'", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "paid" }, error: null });
    const { claimJobAsPaid } = await import("./store");
    await claimJobAsPaid("job-1", {});
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "pending_payment"] });
  });

  it("claimJobAsPaid returns null (not throw) when the guard matched zero rows", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: null, error: null });
    const { claimJobAsPaid } = await import("./store");
    await expect(claimJobAsPaid("job-1", {})).resolves.toBeNull();
  });

  it("expireJobIfPending guards on status = 'pending_payment'", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "expired" }, error: null });
    const { expireJobIfPending } = await import("./store");
    await expireJobIfPending("job-1");
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "pending_payment"] });
  });

  it("claimJobForPrinting guards on status = 'paid' — the exact double-print guard from ROADMAP.md §11", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "printing" }, error: null });
    const { claimJobForPrinting } = await import("./store");
    await claimJobForPrinting("job-1");
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "paid"] });
  });

  it("claimJobForPrinting returns null when another process already claimed it", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: null, error: null });
    const { claimJobForPrinting } = await import("./store");
    await expect(claimJobForPrinting("job-1")).resolves.toBeNull();
  });

  it("deleteJob guards on the exact status it was told the job was in, not just the id", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: [{ id: "job-1" }], error: null });
    const { deleteJob } = await import("./store");
    await deleteJob({ id: "job-1", status: "printed", pdfStoragePath: "job-1.pdf" });
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "printed"] });
  });

  it("deleteJob backs off (returns false) instead of deleting when the row's status already changed", async () => {
    // Empty array = the WHERE (id AND status) matched nothing — the atomic guard did its job.
    mockAdmin.current = createMockQueryBuilder({ data: [], error: null });
    const { deleteJob } = await import("./store");
    await expect(deleteJob({ id: "job-1", status: "printed", pdfStoragePath: "job-1.pdf" })).resolves.toBe(false);
  });
});

// ROADMAP.md §21 — new for v2.5, ported nothing here so there's no v2 test
// to have carried forward. The one correctness property that matters: the
// kiosk id actually reaches next_ticket_number(), and the number/date
// next_ticket_number() returns are what the caller gets back untouched —
// not recomputed, not defaulted, not silently dropped on a partial result.
describe("assignTicketNumber", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.rpcResult = null;
    mockAdmin.rpcCalls = [];
  });

  it("calls next_ticket_number with the given kiosk id and returns its result untouched", async () => {
    mockAdmin.rpcResult = { data: [{ ticket_number: 42, ticket_date: "2026-01-15" }], error: null };
    const { assignTicketNumber } = await import("./store");

    const result = await assignTicketNumber("oxway_02");

    expect(mockAdmin.rpcCalls).toEqual([{ name: "next_ticket_number", args: { p_kiosk_id: "oxway_02" } }]);
    expect(result).toEqual({ ticketNumber: 42, ticketDate: "2026-01-15" });
  });

  it("throws rather than silently returning a bad ticket number when the RPC errors", async () => {
    mockAdmin.rpcResult = { data: null, error: { message: "connection reset" } };
    const { assignTicketNumber } = await import("./store");
    await expect(assignTicketNumber("oxway_01")).rejects.toThrow("connection reset");
  });

  it("throws when the RPC returns no rows — a silent fallback here would mean two jobs could end up with no ticket number instead of failing loudly", async () => {
    mockAdmin.rpcResult = { data: [], error: null };
    const { assignTicketNumber } = await import("./store");
    await expect(assignTicketNumber("oxway_01")).rejects.toThrow();
  });
});
