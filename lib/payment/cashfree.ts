import crypto from "node:crypto";
import { BASE_URL } from "../config";
import type { CreateOrderInput, VerifyResult } from "./types";

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
        customer_phone: "9999999999",
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
