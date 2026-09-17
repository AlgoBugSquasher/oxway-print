import { beforeEach, describe, expect, it, vi } from "vitest";

// Highest-risk logic per ROADMAP.md #14 and the actual reason §11 exists:
// two independent callers (the customer's browser poll and the scheduled
// recheck cron) can call reconcilePendingPayment for the same job at nearly
// the same instant. The one correctness property that matters is: the
// customer gets notified EXACTLY ONCE, never zero, never twice — regardless
// of which caller's atomic claim actually wins.

const mocks = vi.hoisted(() => ({
  verifyOrder: vi.fn(),
  claimJobAsPaid: vi.fn(),
  expireJobIfPending: vi.fn(),
  getJob: vi.fn(),
  notifyPaymentConfirmed: vi.fn(),
  estimateMinutesUntilReady: vi.fn(),
}));

vi.mock("./config", () => ({ PAYMENT_TIMEOUT_SECONDS: 300 }));
vi.mock("./payment", () => ({ verifyOrder: mocks.verifyOrder }));
vi.mock("./notify", () => ({ notifyPaymentConfirmed: mocks.notifyPaymentConfirmed }));
vi.mock("./eta", () => ({ estimateMinutesUntilReady: mocks.estimateMinutesUntilReady }));
vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return { ...actual, claimJobAsPaid: mocks.claimJobAsPaid, expireJobIfPending: mocks.expireJobIfPending, getJob: mocks.getJob };
});

import { reconcilePendingPayment } from "./payment-reconciliation";
import type { PrintJobRecord } from "./store";

function makeJob(overrides: Partial<PrintJobRecord> = {}): PrintJobRecord {
  return {
    id: "job-1",
    status: "pending_payment",
    fileName: "doc.pdf",
    selectedPages: [1, 2],
    settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
    totalPrice: 10,
    phoneNumber: "9876543210",
    includeBannerPage: false,
    contentHash: "hash",
    provider: "razorpay",
    providerOrderId: "order_1",
    pdfStoragePath: "job-1.pdf",
    kioskId: "oxway_01",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.estimateMinutesUntilReady.mockResolvedValue(5);
});

describe("reconcilePendingPayment", () => {
  it("leaves a non-pending_payment job untouched and never checks the gateway", async () => {
    const job = makeJob({ status: "paid" });
    const result = await reconcilePendingPayment(job);
    expect(result).toBe(job);
    expect(mocks.verifyOrder).not.toHaveBeenCalled();
  });

  it("expires a job older than the payment timeout without checking the gateway", async () => {
    const job = makeJob({ createdAt: new Date(Date.now() - 400_000).toISOString() });
    mocks.expireJobIfPending.mockResolvedValue({ ...job, status: "expired" });
    const result = await reconcilePendingPayment(job);
    expect(result.status).toBe("expired");
    expect(mocks.verifyOrder).not.toHaveBeenCalled();
  });

  it("leaves the job as pending_payment when the gateway hasn't confirmed payment yet", async () => {
    const job = makeJob();
    mocks.verifyOrder.mockResolvedValue({ paid: false });
    const result = await reconcilePendingPayment(job);
    expect(result.status).toBe("pending_payment");
    expect(mocks.claimJobAsPaid).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentConfirmed).not.toHaveBeenCalled();
  });

  // ROADMAP.md §2 (notifications) is disabled for v2.5 — reconcilePendingPayment
  // no longer calls notifyPaymentConfirmed at all (see that file's own §2
  // comment), so these two tests assert it's never called, full stop. The
  // atomic-claim race behavior underneath (§11's actual reason this file
  // exists) is unchanged and still covered.
  it("claims the job (and does not notify — §2 disabled) when payment is confirmed and the claim succeeds", async () => {
    const job = makeJob();
    const claimed = { ...job, status: "paid" as const };
    mocks.verifyOrder.mockResolvedValue({ paid: true, paymentRef: "pay_1" });
    mocks.claimJobAsPaid.mockResolvedValue(claimed);

    const result = await reconcilePendingPayment(job);

    expect(result.status).toBe("paid");
    expect(result).toBe(claimed);
    expect(mocks.notifyPaymentConfirmed).not.toHaveBeenCalled();
  });

  it("reflects the other caller's outcome, without re-claiming, when another caller already won the atomic claim — the exact race §11 exists to prevent", async () => {
    const job = makeJob();
    const alreadyClaimedByOtherCaller = { ...job, status: "paid" as const };
    mocks.verifyOrder.mockResolvedValue({ paid: true, paymentRef: "pay_1" });
    // claimJobAsPaid's atomic UPDATE...WHERE matched zero rows because the
    // other caller (browser poll vs. cron) already flipped the status first.
    mocks.claimJobAsPaid.mockResolvedValue(null);
    mocks.getJob.mockResolvedValue(alreadyClaimedByOtherCaller);

    const result = await reconcilePendingPayment(job);

    expect(result.status).toBe("paid");
    expect(mocks.notifyPaymentConfirmed).not.toHaveBeenCalled();
  });
});
