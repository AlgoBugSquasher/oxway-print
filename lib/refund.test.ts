import { beforeEach, describe, expect, it, vi } from "vitest";

// ROADMAP.md #10 — real money movement. The one thing that must never
// happen for a free staff print: attemptRefund reaching refundOrder at all
// — there's no captured payment, no real gateway order, nothing to refund,
// and `provider` is still set to a real (but meaningless) gateway value on
// a staff job, so only an explicit payment_method check protects this.

const mocks = vi.hoisted(() => ({
  refundOrder: vi.fn(async () => ({ refundId: "rfnd_1" })),
  rpc: vi.fn(async (): Promise<{ data: null; error: { message: string } | null }> => ({ data: null, error: null })),
}));

vi.mock("./payment", () => ({ refundOrder: mocks.refundOrder }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));

import { attemptRefund } from "./refund";
import type { PrintJobRecord } from "./store";

function makeJob(overrides: Partial<PrintJobRecord> = {}): PrintJobRecord {
  return {
    id: "job-1",
    status: "print_failed",
    fileName: "doc.pdf",
    selectedPages: [1],
    settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
    totalPrice: 10,
    phoneNumber: "",
    notifyOptIn: false,
    provider: "razorpay",
    providerOrderId: "order_1",
    providerMeta: { paymentRef: "pay_1" },
    pdfStoragePath: "job-1.pdf",
    includeBannerPage: true,
    contentHash: "hash",
    kioskId: "oxway_01",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attemptRefund", () => {
  it("refunds a normal failed razorpay job", async () => {
    const result = await attemptRefund(makeJob());
    expect(result).toEqual({ ok: true, refundId: "rfnd_1" });
    expect(mocks.refundOrder).toHaveBeenCalledWith({ provider: "razorpay", providerOrderId: "order_1", paymentRef: "pay_1", amountRupees: 10 });
  });

  it("never calls refundOrder for a staff job — checked before every other guard, including already-refunded", async () => {
    const job = makeJob({ paymentMethod: "staff", isFree: true, waivedAmount: 10, totalPrice: 0, providerOrderId: "", providerMeta: undefined });
    const result = await attemptRefund(job);
    expect(result).toEqual({ ok: false, reason: "staff_job" });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it("a staff job's own meaningless `provider: razorpay` value alone is not what's being guarded against — paymentMethod is", async () => {
    // Deliberately exercises the exact gap a provider-only check would
    // have: provider says razorpay, but this was never a Razorpay payment.
    const job = makeJob({ paymentMethod: "staff", provider: "razorpay", providerOrderId: "", providerMeta: undefined });
    await attemptRefund(job);
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it("refuses a second refund on an already-refunded job", async () => {
    const result = await attemptRefund(makeJob({ refundedAt: new Date().toISOString() }));
    expect(result).toEqual({ ok: false, reason: "already_refunded" });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it("refuses a razorpay job with no captured payment reference", async () => {
    const result = await attemptRefund(makeJob({ providerMeta: {} }));
    expect(result).toEqual({ ok: false, reason: "no_captured_payment" });
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it("marks the job refunded (via record_refund, one DB transaction with its audit entry) after a successful refund", async () => {
    await attemptRefund(makeJob());
    expect(mocks.rpc).toHaveBeenCalledWith("record_refund", {
      p_job_id: "job-1",
      p_refund_id: "rfnd_1",
      p_actor_user_id: null,
      p_actor_role: null,
      p_ip: null,
      p_user_agent: null,
    });
  });

  it("passes the actor through to record_refund for a human-initiated refund", async () => {
    await attemptRefund(makeJob(), { userId: "owner-1", role: "owner", ip: "1.2.3.4", userAgent: "Mozilla/5.0" });
    expect(mocks.rpc).toHaveBeenCalledWith("record_refund", {
      p_job_id: "job-1",
      p_refund_id: "rfnd_1",
      p_actor_user_id: "owner-1",
      p_actor_role: "owner",
      p_ip: "1.2.3.4",
      p_user_agent: "Mozilla/5.0",
    });
  });

  it("still reports the refund as successful even if record_refund itself fails — the money already moved", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await attemptRefund(makeJob());
    expect(result).toEqual({ ok: true, refundId: "rfnd_1" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
