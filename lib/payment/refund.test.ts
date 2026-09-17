import { describe, expect, it, vi } from "vitest";

// ROADMAP.md #10 — real money movement. The one thing that must never
// happen: calling Razorpay's refund API without a captured payment id (there
// would be nothing to refund), or refunding the wrong gateway.

const mocks = vi.hoisted(() => ({
  refundRazorpayPayment: vi.fn(async () => ({ refundId: "rfnd_razorpay_1" })),
  refundCashfreeOrder: vi.fn(async () => ({ refundId: "rfnd_cashfree_1" })),
}));

vi.mock("./razorpay", () => ({ refundRazorpayPayment: mocks.refundRazorpayPayment }));
vi.mock("./cashfree", () => ({ refundCashfreeOrder: mocks.refundCashfreeOrder }));
vi.mock("../config", () => ({ getActiveProvider: () => "razorpay" }));

import { refundOrder } from "./index";

describe("refundOrder", () => {
  it("routes a razorpay refund to refundRazorpayPayment using paymentRef, not providerOrderId", async () => {
    await refundOrder({ provider: "razorpay", providerOrderId: "order_1", paymentRef: "pay_1", amountRupees: 10 });
    expect(mocks.refundRazorpayPayment).toHaveBeenCalledWith("pay_1", 10);
    expect(mocks.refundCashfreeOrder).not.toHaveBeenCalled();
  });

  it("routes a cashfree refund to refundCashfreeOrder using providerOrderId, not paymentRef", async () => {
    await refundOrder({ provider: "cashfree", providerOrderId: "order_2", paymentRef: undefined, amountRupees: 25 });
    expect(mocks.refundCashfreeOrder).toHaveBeenCalledWith("order_2", 25);
    expect(mocks.refundRazorpayPayment).not.toHaveBeenCalled();
  });

  it("refuses to attempt a razorpay refund with no captured payment reference, rather than calling the gateway with nothing to refund", async () => {
    await expect(
      refundOrder({ provider: "razorpay", providerOrderId: "order_3", paymentRef: undefined, amountRupees: 10 })
    ).rejects.toThrow(/no captured payment reference/i);
    expect(mocks.refundRazorpayPayment).not.toHaveBeenCalled();
  });

  it("refuses to attempt a razorpay refund with an empty-string payment reference (the exact value a failed lookup stores)", async () => {
    await expect(
      refundOrder({ provider: "razorpay", providerOrderId: "order_4", paymentRef: "", amountRupees: 10 })
    ).rejects.toThrow(/no captured payment reference/i);
    expect(mocks.refundRazorpayPayment).not.toHaveBeenCalled();
  });
});
