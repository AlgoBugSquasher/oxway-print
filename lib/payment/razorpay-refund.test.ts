import { beforeEach, describe, expect, it, vi } from "vitest";

// Real money movement. The two things that must never happen: calling the
// refund endpoint a second time once Razorpay already considers the
// payment fully refunded (it would just reject it), and sending anything
// other than normal speed (this app's refunds are a reviewed, owner-
// approved action on a 5-7 business day schedule, never instant).

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  refund: vi.fn(),
  fetchMultipleRefund: vi.fn(),
}));

vi.mock("razorpay", () => ({
  // A plain `function`, not an arrow function — `new Razorpay(...)` in
  // lib/payment/razorpay.ts actually invokes this as a constructor, and
  // arrow functions can never be used with `new` (throws "is not a
  // constructor"), unlike a real function/class.
  default: vi.fn().mockImplementation(function RazorpayMock() {
    return { payments: { fetch: mocks.fetch, refund: mocks.refund, fetchMultipleRefund: mocks.fetchMultipleRefund } };
  }),
}));

import { refundRazorpayPayment } from "./razorpay";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "test_secret";
  mocks.fetch.mockResolvedValue({ id: "pay_1", refund_status: "null" });
});

describe("refundRazorpayPayment", () => {
  it("refunds the exact amount at normal speed", async () => {
    mocks.refund.mockResolvedValue({ id: "rfnd_1" });
    const result = await refundRazorpayPayment("pay_1", 12.5);

    expect(mocks.refund).toHaveBeenCalledWith("pay_1", { amount: 1250, speed: "normal" });
    expect(result).toEqual({ refundId: "rfnd_1" });
  });

  it("never calls the refund endpoint again if the payment is already fully refunded at Razorpay — returns the existing refund id with alreadyRefunded: true", async () => {
    mocks.fetch.mockResolvedValue({ id: "pay_1", refund_status: "full" });
    mocks.fetchMultipleRefund.mockResolvedValue({ items: [{ id: "rfnd_old" }] });

    const result = await refundRazorpayPayment("pay_1", 10);

    expect(result).toEqual({ refundId: "rfnd_old", alreadyRefunded: true });
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("falls back to the payment id itself if the existing refund's own id can't be looked up", async () => {
    mocks.fetch.mockResolvedValue({ id: "pay_1", refund_status: "full" });
    mocks.fetchMultipleRefund.mockRejectedValue(new Error("network error"));

    const result = await refundRazorpayPayment("pay_1", 10);
    expect(result).toEqual({ refundId: "pay_1", alreadyRefunded: true });
  });

  it("falls through to a real refund attempt if the pre-check itself fails, rather than refusing to refund at all", async () => {
    mocks.fetch.mockRejectedValue(new Error("network error"));
    mocks.refund.mockResolvedValue({ id: "rfnd_1" });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refundRazorpayPayment("pay_1", 10);

    expect(result).toEqual({ refundId: "rfnd_1" });
    expect(mocks.refund).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("treats Razorpay's own 'already fully refunded' error as success instead of throwing — a race between the pre-check and the real call", async () => {
    mocks.refund.mockRejectedValue({ error: { description: "The payment has been fully refunded already" } });
    mocks.fetchMultipleRefund.mockResolvedValue({ items: [{ id: "rfnd_old" }] });

    const result = await refundRazorpayPayment("pay_1", 10);
    expect(result).toEqual({ refundId: "rfnd_old", alreadyRefunded: true });
  });

  it("still throws a genuine refund failure unrelated to an existing refund", async () => {
    mocks.refund.mockRejectedValue({ error: { description: "Refund is not supported by the bank because the payment is more than 6 months old" } });
    await expect(refundRazorpayPayment("pay_1", 10)).rejects.toBeDefined();
  });
});
