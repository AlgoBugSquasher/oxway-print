import { beforeEach, describe, expect, it, vi } from "vitest";

// Refund approval workflow (replaces the old print-agent auto-refund):
// attemptRefund now takes a jobId (not a stale in-memory job object) and
// starts by atomically claiming it via claim_refund_for_processing —
// everything after that mirrors the gateway call shape the old tests
// already covered, just reached through the new claim-then-resolve path.

const mocks = vi.hoisted(() => ({
  refundOrder: vi.fn(async (): Promise<{ refundId: string; alreadyRefunded?: boolean }> => ({ refundId: "rfnd_1" })),
  rpc: vi.fn(),
}));

vi.mock("./payment", () => ({ refundOrder: mocks.refundOrder }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));

import { attemptRefund, recordBulkRefundAction } from "./refund";

interface ClaimedJobRow {
  id: string;
  status: string;
  total_price: number;
  provider: "cashfree" | "razorpay";
  provider_order_id: string;
  provider_meta: Record<string, string> | null;
  payment_method: "razorpay" | "cashfree" | "staff" | null;
}

function makeClaimedJob(overrides: Partial<ClaimedJobRow> = {}): ClaimedJobRow {
  return {
    id: "job-1",
    status: "print_failed",
    total_price: 10,
    provider: "razorpay",
    provider_order_id: "order_1",
    provider_meta: { paymentRef: "pay_1" },
    payment_method: "razorpay",
    ...overrides,
  };
}

/** Default happy-path RPC responses, overridden per test via mockImplementation. */
function setupRpc(options: { claim?: ClaimedJobRow | null; claimError?: string; completeError?: string } = {}) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_refund_for_processing") {
      if (options.claimError) return { data: null, error: { message: options.claimError } };
      return { data: options.claim === undefined ? [makeClaimedJob()] : options.claim ? [options.claim] : [], error: null };
    }
    if (name === "complete_refund") {
      return options.completeError ? { data: null, error: { message: options.completeError } } : { data: null, error: null };
    }
    if (name === "fail_refund") return { data: null, error: null };
    if (name === "record_refund_bulk_action") return { data: null, error: null };
    throw new Error(`Unexpected RPC call: ${name}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attemptRefund", () => {
  it("claims the job, refunds it at the gateway, and completes the claim", async () => {
    setupRpc();
    const result = await attemptRefund("job-1");

    expect(mocks.rpc).toHaveBeenCalledWith("claim_refund_for_processing", { p_job_id: "job-1" });
    expect(mocks.refundOrder).toHaveBeenCalledWith({ provider: "razorpay", providerOrderId: "order_1", paymentRef: "pay_1", amountRupees: 10 });
    expect(mocks.rpc).toHaveBeenCalledWith("complete_refund", {
      p_job_id: "job-1",
      p_refund_id: "rfnd_1",
      p_already_refunded_at_provider: false,
      p_actor_user_id: null,
      p_actor_role: null,
      p_ip: null,
      p_user_agent: null,
    });
    expect(result).toEqual({ ok: true, refundId: "rfnd_1", amountRupees: 10, alreadyRefundedAtProvider: false });
  });

  it("refuses and reports the server's exact reason when the atomic claim itself fails (double click / two tabs / already refunded / reprinted since failing)", async () => {
    setupRpc({ claimError: "This refund is already being processed — try again in a moment." });
    const result = await attemptRefund("job-1");

    expect(result).toEqual({ ok: false, reason: "This refund is already being processed — try again in a moment." });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it("never calls refundOrder for a staff job even if somehow claimed (defensive — the trigger should already exclude one) and releases the claim via fail_refund", async () => {
    setupRpc({ claim: makeClaimedJob({ payment_method: "staff", provider_order_id: "", provider_meta: null }) });
    const result = await attemptRefund("job-1");

    expect(result).toEqual({ ok: false, reason: "This was a free staff print — nothing was charged, so there's nothing to refund." });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("fail_refund", expect.objectContaining({ p_job_id: "job-1", p_error: "Staff job — nothing to refund." }));
  });

  it("refuses a razorpay job with no captured payment reference, and releases the claim", async () => {
    setupRpc({ claim: makeClaimedJob({ provider_meta: {} }) });
    const result = await attemptRefund("job-1");

    expect(result).toEqual({ ok: false, reason: "No captured payment reference on this job — nothing to refund." });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("fail_refund", expect.objectContaining({ p_job_id: "job-1", p_error: "No captured payment reference." }));
  });

  it("resolves the claim as failed (not stuck at 'processing' forever) when the gateway itself throws", async () => {
    setupRpc();
    mocks.refundOrder.mockRejectedValueOnce(new Error("Razorpay: gateway timeout"));

    const result = await attemptRefund("job-1");

    expect(result).toEqual({ ok: false, reason: "Razorpay: gateway timeout" });
    expect(mocks.rpc).toHaveBeenCalledWith("fail_refund", expect.objectContaining({ p_job_id: "job-1", p_error: "Razorpay: gateway timeout" }));
  });

  it("treats a gateway 'already refunded' response as success, recording it as such", async () => {
    setupRpc();
    mocks.refundOrder.mockResolvedValueOnce({ refundId: "rfnd_old", alreadyRefunded: true });

    const result = await attemptRefund("job-1");

    expect(result).toEqual({ ok: true, refundId: "rfnd_old", amountRupees: 10, alreadyRefundedAtProvider: true });
    expect(mocks.rpc).toHaveBeenCalledWith("complete_refund", expect.objectContaining({ p_refund_id: "rfnd_old", p_already_refunded_at_provider: true }));
  });

  it("passes the actor through to complete_refund for a human-initiated refund", async () => {
    setupRpc();
    await attemptRefund("job-1", { userId: "owner-1", role: "owner", ip: "1.2.3.4", userAgent: "Mozilla/5.0" });

    expect(mocks.rpc).toHaveBeenCalledWith("complete_refund", expect.objectContaining({
      p_actor_user_id: "owner-1", p_actor_role: "owner", p_ip: "1.2.3.4", p_user_agent: "Mozilla/5.0",
    }));
  });

  it("still reports the refund as successful even if complete_refund itself fails — the money already moved", async () => {
    setupRpc({ completeError: "db down" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await attemptRefund("job-1");

    expect(result).toEqual({ ok: true, refundId: "rfnd_1", amountRupees: 10, alreadyRefundedAtProvider: false });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reports a claim that returns no row as a clear failure rather than throwing", async () => {
    setupRpc({ claim: null });
    const result = await attemptRefund("job-1");
    expect(result).toEqual({ ok: false, reason: "Could not claim this job for refunding." });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });
});

describe("recordBulkRefundAction", () => {
  it("calls record_refund_bulk_action with the job ids, total, and per-outcome counts", async () => {
    setupRpc();
    await recordBulkRefundAction({
      jobIds: ["job-1", "job-2"],
      totalRupees: 25,
      succeeded: 1,
      failed: 1,
      actor: { userId: "owner-1", role: "owner", ip: "1.2.3.4", userAgent: "Mozilla/5.0" },
    });

    expect(mocks.rpc).toHaveBeenCalledWith("record_refund_bulk_action", {
      p_job_ids: ["job-1", "job-2"],
      p_total: 25,
      p_succeeded: 1,
      p_failed: 1,
      p_actor_user_id: "owner-1",
      p_actor_role: "owner",
      p_ip: "1.2.3.4",
      p_user_agent: "Mozilla/5.0",
    });
  });

  it("logs but never throws if the RPC itself fails — a missing audit summary must never break the refund flow that already succeeded", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordBulkRefundAction({ jobIds: ["job-1"], totalRupees: 10, succeeded: 1, failed: 0, actor: {} })).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
