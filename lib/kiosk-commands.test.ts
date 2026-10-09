import { beforeEach, describe, expect, it, vi } from "vitest";

// Same risk class as lib/store.test.ts's claim functions (ROADMAP.md #14):
// claimPendingKioskCommand is what stands between "the agent only ever runs
// an update/restart it legitimately claimed" and a command somehow being
// run twice. These tests assert the atomic UPDATE ... WHERE status =
// 'pending' guard is actually present in the built query, not just that the
// function returns a plausible-looking value.

/** Same generic recording builder as lib/store.test.ts, generalized to resolve a QUEUE of results — claimPendingKioskCommand awaits two separate chained calls (a select, then an update), each needing its own canned response. */
function createMockQueryBuilder(results: { data: unknown; error: unknown }[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const CHAIN_METHODS = ["from", "select", "update", "eq", "neq", "order", "limit", "maybeSingle"];
  let callIndex = 0;
  const builder: Record<string, unknown> = { __calls: calls };
  for (const method of CHAIN_METHODS) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
    const result = results[Math.min(callIndex, results.length - 1)];
    callIndex += 1;
    return resolve(result);
  };
  return builder as { __calls: typeof calls } & Record<string, (...args: unknown[]) => unknown>;
}

const mockAdmin = vi.hoisted(() => ({
  current: null as ReturnType<typeof createMockQueryBuilder> | null,
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: () => mockAdmin.current,
  }),
}));

beforeEach(() => {
  vi.resetModules();
  mockAdmin.current = null;
});

describe("claimPendingKioskCommand", () => {
  it("returns null without attempting an update when there is no pending command", async () => {
    mockAdmin.current = createMockQueryBuilder([{ data: [], error: null }]);
    const { claimPendingKioskCommand } = await import("./kiosk-commands");

    const result = await claimPendingKioskCommand("oxway_01");

    expect(result).toBeNull();
    const updateCalls = mockAdmin.current.__calls.filter((call) => call.method === "update");
    expect(updateCalls).toHaveLength(0);
  });

  it("claims the oldest pending row by guarding the update on status = 'pending'", async () => {
    mockAdmin.current = createMockQueryBuilder([
      { data: [{ id: "cmd-1" }], error: null },
      { data: { id: "cmd-1", kiosk_id: "oxway_01", command: "update" }, error: null },
    ]);
    const { claimPendingKioskCommand } = await import("./kiosk-commands");

    const result = await claimPendingKioskCommand("oxway_01");

    expect(result).toEqual({ id: "cmd-1", kioskId: "oxway_01", command: "update" });
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "pending"] });
    const updateCalls = mockAdmin.current.__calls.filter((call) => call.method === "update");
    expect(updateCalls).toEqual([{ method: "update", args: [{ status: "running" }] }]);
  });

  it("returns null (not throw) when the claim's own guard matched zero rows — e.g. lost a race", async () => {
    mockAdmin.current = createMockQueryBuilder([
      { data: [{ id: "cmd-1" }], error: null },
      { data: null, error: null },
    ]);
    const { claimPendingKioskCommand } = await import("./kiosk-commands");

    await expect(claimPendingKioskCommand("oxway_01")).resolves.toBeNull();
  });
});

describe("finishKioskCommand", () => {
  it("writes status, result, and finished_at in one update", async () => {
    mockAdmin.current = createMockQueryBuilder([{ data: null, error: null }]);
    const { finishKioskCommand } = await import("./kiosk-commands");

    await finishKioskCommand("cmd-1", "done", "Updated successfully to abc1234.");

    const updateCalls = mockAdmin.current.__calls.filter((call) => call.method === "update");
    expect(updateCalls).toHaveLength(1);
    const patch = updateCalls[0].args[0] as Record<string, unknown>;
    expect(patch.status).toBe("done");
    expect(patch.result).toBe("Updated successfully to abc1234.");
    expect(typeof patch.finished_at).toBe("string");
  });
});
