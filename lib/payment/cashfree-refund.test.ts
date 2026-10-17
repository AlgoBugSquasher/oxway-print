import { beforeEach, describe, expect, it, vi } from "vitest";

// UNTESTED against a real Cashfree account (see refundCashfreeOrder's own
// docstring) — this still verifies the logic actually written against
// Cashfree's documented API shape: the pre-check against existing refunds,
// the explicit "always STANDARD speed" requirement, and the already-
// refunded fallback, all independent of whether Cashfree is ever actually
// wired up.

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

import { refundCashfreeOrder } from "./cashfree";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CASHFREE_APP_ID = "test_app_id";
  process.env.CASHFREE_SECRET_KEY = "test_secret";
});

describe("refundCashfreeOrder", () => {
  it("refunds the exact amount at STANDARD speed, after pre-checking for nothing (no existing refunds)", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([])) // pre-check: GET .../refunds
      .mockResolvedValueOnce(jsonResponse({ refund_id: "rfnd_1" })); // POST .../refunds

    const result = await refundCashfreeOrder("order_1", 20);

    expect(result).toEqual({ refundId: "rfnd_1" });
    const [, postCall] = mockFetch.mock.calls;
    expect(postCall[0]).toContain("/orders/order_1/refunds");
    const body = JSON.parse(postCall[1].body);
    expect(body.refund_speed).toBe("STANDARD");
    expect(body.refund_amount).toBe(20);
  });

  it("never calls the create-refund endpoint if existing SUCCESS refunds already cover the full amount — returns alreadyRefunded: true instead", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([{ refund_status: "SUCCESS", refund_amount: 20, cf_refund_id: 555 }]));

    const result = await refundCashfreeOrder("order_1", 20);

    expect(result).toEqual({ refundId: "555", alreadyRefunded: true });
    expect(mockFetch).toHaveBeenCalledTimes(1); // pre-check only, never the POST
  });

  it("still attempts a real refund if existing SUCCESS refunds only partially cover the amount", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([{ refund_status: "SUCCESS", refund_amount: 5, cf_refund_id: 1 }]))
      .mockResolvedValueOnce(jsonResponse({ refund_id: "rfnd_2" }));

    const result = await refundCashfreeOrder("order_1", 20);
    expect(result).toEqual({ refundId: "rfnd_2" });
  });

  it("falls through to a real refund attempt if the pre-check itself fails", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null, false)).mockResolvedValueOnce(jsonResponse({ refund_id: "rfnd_1" }));
    const result = await refundCashfreeOrder("order_1", 20);
    expect(result).toEqual({ refundId: "rfnd_1" });
  });

  it("treats an 'already refunded'-shaped error from the create call as success rather than throwing", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([])) // pre-check sees nothing yet (a race)
      .mockResolvedValueOnce(jsonResponse({ message: "refund amount already exceeds refundable amount" }, false)) // the real call fails because it actually was already refunded
      .mockResolvedValueOnce(jsonResponse([{ refund_status: "SUCCESS", refund_amount: 20, cf_refund_id: 9 }])); // re-check after the failure

    const result = await refundCashfreeOrder("order_1", 20);
    expect(result).toEqual({ refundId: "9", alreadyRefunded: true });
  });

  it("still throws a genuine refund failure unrelated to an existing refund", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ message: "Invalid order_id" }, false));

    await expect(refundCashfreeOrder("order_1", 20)).rejects.toThrow("Invalid order_id");
  });
});
