import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: mock.rpcError });
    },
  }),
}));

import { logAudit, maskEmail, maskPhone } from "./audit";

beforeEach(() => {
  mock.rpcCalls.length = 0;
  mock.rpcError = null;
});

describe("logAudit", () => {
  it("calls the log_audit RPC with every field mapped to its p_ parameter", async () => {
    await logAudit({
      action: "job_cancelled",
      actorUserId: "user-1",
      actorRole: "owner",
      kioskId: "oxway_01",
      targetType: "print_job",
      targetId: "job-1",
      details: { before: { status: "paid" }, after: { status: "cancelled" } },
      ip: "1.2.3.4",
      userAgent: "test-agent",
    });

    expect(mock.rpcCalls).toEqual([
      {
        name: "log_audit",
        args: {
          p_action: "job_cancelled",
          p_actor_user_id: "user-1",
          p_actor_role: "owner",
          p_kiosk_id: "oxway_01",
          p_target_type: "print_job",
          p_target_id: "job-1",
          p_details: { before: { status: "paid" }, after: { status: "cancelled" } },
          p_ip: "1.2.3.4",
          p_user_agent: "test-agent",
        },
      },
    ]);
  });

  it("defaults every optional field to null rather than undefined", async () => {
    await logAudit({ action: "sign_out" });

    expect(mock.rpcCalls[0].args).toEqual({
      p_action: "sign_out",
      p_actor_user_id: null,
      p_actor_role: null,
      p_kiosk_id: null,
      p_target_type: null,
      p_target_id: null,
      p_details: null,
      p_ip: null,
      p_user_agent: null,
    });
  });

  it("never throws when the RPC itself returns an error — a failed audit write must not crash the caller", async () => {
    mock.rpcError = { message: "connection reset" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(logAudit({ action: "pricing_updated" })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled(); // but it IS loud about it
    consoleError.mockRestore();
  });
});

describe("maskPhone", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskPhone("9876543210")).toBe("***3210");
  });

  it("passes through an empty string unchanged — nothing to mask", () => {
    expect(maskPhone("")).toBe("");
  });
});

describe("maskEmail", () => {
  it("keeps the first character of the local part, its length, and the real domain", () => {
    expect(maskEmail("owner@example.com")).toBe("o***(5)@example.com");
  });

  it("falls back to a fixed placeholder for a string with no @", () => {
    expect(maskEmail("not-an-email")).toBe("***");
  });
});
