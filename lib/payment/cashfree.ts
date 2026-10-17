import crypto from "node:crypto";
import { BASE_URL } from "../config";
import type { CreateOrderInput, RefundResult, VerifyResult } from "./types";

const CASHFREE_BASE = process.env.CASHFREE_ENV === "production"
  ? "https://api.cashfree.com/pg"
  : "https://sandbox.cashfree.com/pg";

function credentials() {
  const clientId = process.env.CASHFREE_APP_ID;
  const clientSecret = process.env.CASHFREE_SECRET_KEY;
  if (!clientId || !clientSecret) {
    throw new Error("CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not configured.");
  }
  return { clientId, clientSecret };
}

// Phone number collection (ROADMAP.md §1) is disabled for v2.5, so
// input.phone is always "" — Cashfree's API rejects an empty
// customer_phone outright, so this placeholder fills that requirement the
// way the field worked before §1 existed. Picks up a real number
// automatically, with no change needed here, if §1 is ever re-enabled.
const PLACEHOLDER_PHONE = "9999999999";

function authHeaders() {
  const { clientId, clientSecret } = credentials();
  return {
    "Content-Type": "application/json",
    "x-api-version": "2023-08-01",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
  };
}

export async function createCashfreeOrder(input: CreateOrderInput) {
  const response = await fetch(`${CASHFREE_BASE}/orders`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      order_id: `oxway_${input.jobId}`,
      order_amount: Number(input.amountRupees),
      order_currency: "INR",
      customer_details: {
        customer_id: `kiosk_${input.jobId}`,
        customer_phone: input.phone || PLACEHOLDER_PHONE,
        customer_name: "Kiosk User",
      },
      order_meta: {
        return_url: `${BASE_URL}/?jobId=${input.jobId}`,
        notify_url: `${BASE_URL}/api/webhook/cashfree`,
      },
      order_note: input.fileName,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || "Cashfree order creation failed.");
  }

  return {
    provider: "cashfree" as const,
    providerOrderId: data.order_id as string,
    paymentSessionId: data.payment_session_id as string,
  };
}

/** Outbound status check — works even if the kiosk has no public inbound webhook URL. */
export async function verifyCashfreeOrder(providerOrderId: string): Promise<VerifyResult> {
  const response = await fetch(`${CASHFREE_BASE}/orders/${providerOrderId}`, {
    headers: authHeaders(),
  });
  if (!response.ok) return { paid: false };
  const data = await response.json();
  if (data.order_status !== "PAID") return { paid: false };

  let paymentRef: string | undefined;
  try {
    const paymentsResponse = await fetch(`${CASHFREE_BASE}/orders/${providerOrderId}/payments`, {
      headers: authHeaders(),
    });
    if (paymentsResponse.ok) {
      const payments = await paymentsResponse.json();
      const successful = Array.isArray(payments)
        ? payments.find((payment: { payment_status?: string }) => payment.payment_status === "SUCCESS")
        : null;
      paymentRef = successful?.cf_payment_id ? String(successful.cf_payment_id) : undefined;
    }
  } catch {
    // Non-fatal — order_status === "PAID" is already the source of truth.
  }

  return { paid: true, paymentRef };
}

/**
 * Real money movement. UNTESTED: Cashfree isn't live yet (no account/KYC
 * per PAYMENT_PROVIDER=razorpay), so this has never been run against a
 * real Cashfree order. Written for symmetry with refundRazorpayPayment and
 * against Cashfree's documented API shape, not verified. Cashfree refunds
 * by order_id (unlike Razorpay, which refunds by payment id) — needs its
 * own unique refund_id per attempt as an idempotency key, which Cashfree
 * requires and we don't otherwise track. `refund_speed: "STANDARD"` is
 * explicit, not left to Cashfree's own default — same "always normal
 * speed, never instant" requirement refundRazorpayPayment's own
 * `speed: "normal"` satisfies.
 *
 * Pre-checks this order's existing refunds before attempting a new one:
 * if a previous SUCCESS refund already covers the full amount (a previous
 * attempt whose own DB write failed, retried later — see
 * refundRazorpayPayment's identical reasoning), this returns success with
 * `alreadyRefunded: true` instead of calling the refund endpoint again.
 */
export async function refundCashfreeOrder(providerOrderId: string, amountRupees: number): Promise<RefundResult> {
  const existing = await findSuccessfulCashfreeRefund(providerOrderId, amountRupees);
  if (existing) return { refundId: existing, alreadyRefunded: true };

  const response = await fetch(`${CASHFREE_BASE}/orders/${providerOrderId}/refunds`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      refund_amount: Number(amountRupees),
      refund_id: crypto.randomUUID(),
      refund_speed: "STANDARD",
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = String(data?.message ?? "");
    if (/refund/i.test(message) && /(already|exceed)/i.test(message)) {
      const alreadyRefunded = await findSuccessfulCashfreeRefund(providerOrderId, amountRupees);
      if (alreadyRefunded) return { refundId: alreadyRefunded, alreadyRefunded: true };
    }
    throw new Error(data?.message || "Cashfree refund failed.");
  }
  return { refundId: String(data.refund_id) };
}

/** Returns the first SUCCESS refund's id once this order's successful refunds already sum to the full amount, or null if nothing covers it yet. Best-effort — a failed lookup here just means the caller falls through to attempting a real refund, same as everywhere else this pattern is used. */
async function findSuccessfulCashfreeRefund(providerOrderId: string, amountRupees: number): Promise<string | null> {
  try {
    const response = await fetch(`${CASHFREE_BASE}/orders/${providerOrderId}/refunds`, { headers: authHeaders() });
    if (!response.ok) return null;
    const refunds = await response.json();
    if (!Array.isArray(refunds)) return null;
    const successful = refunds.filter((r: { refund_status?: string }) => r.refund_status === "SUCCESS");
    const total = successful.reduce((sum: number, r: { refund_amount?: number }) => sum + Number(r.refund_amount ?? 0), 0);
    if (total <= 0 || total < amountRupees) return null;
    const first = successful[0] as { cf_refund_id?: number | string; refund_id?: string } | undefined;
    return first ? String(first.cf_refund_id ?? first.refund_id ?? providerOrderId) : null;
  } catch {
    return null;
  }
}

/**
 * Cashfree signs webhooks as base64(HMAC_SHA256(secret, timestamp + rawBody)).
 * Set CASHFREE_WEBHOOK_SECRET to the secret shown on the dashboard's webhook page;
 * falls back to CASHFREE_SECRET_KEY for sandbox testing.
 */
export function verifyCashfreeWebhookSignature(rawBody: string, signature: string, timestamp: string): boolean {
  const secret = process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
