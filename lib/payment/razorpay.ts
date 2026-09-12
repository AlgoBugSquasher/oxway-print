import crypto from "node:crypto";
import Razorpay from "razorpay";
import type { CreateOrderInput, VerifyResult } from "./types";

function client() {
  const keyId = process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

/**
 * Standard Razorpay Checkout order — the frontend opens Razorpay's own
 * checkout.js modal with this order id, which lets the customer pick
 * Card / Netbanking / UPI (UPI shows its own QR + intent options), same as
 * Cashfree's modal. `keyId` is the public key id (safe to expose to the
 * browser) so the frontend can build the Checkout options in one round trip.
 */
export async function createRazorpayOrder(input: CreateOrderInput) {
  const razorpay = client();
  const order = await razorpay.orders.create({
    amount: Math.round(input.amountRupees * 100),
    currency: "INR",
    receipt: input.jobId,
    notes: { jobId: input.jobId },
  });

  return {
    provider: "razorpay" as const,
    providerOrderId: order.id,
    keyId: (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID)!,
    amount: Number(order.amount),
  };
}

/** Outbound status check against Razorpay — no inbound webhook required. */
export async function verifyRazorpayOrder(orderId: string): Promise<VerifyResult> {
  const razorpay = client();
  const order = await razorpay.orders.fetch(orderId);
  if (order.status !== "paid") return { paid: false };

  let paymentRef: string | undefined;
  try {
    const payments = await razorpay.orders.fetchPayments(orderId);
    const captured = payments.items.find((payment) => payment.status === "captured");
    paymentRef = captured?.id;
  } catch {
    // Non-fatal — order.status === "paid" is already the source of truth.
  }

  return { paid: true, paymentRef };
}

/**
 * Razorpay signs webhooks as hex(HMAC_SHA256(webhookSecret, rawBody)) in the
 * `X-Razorpay-Signature` header. Configure the same secret in the Razorpay
 * dashboard's webhook settings as RAZORPAY_WEBHOOK_SECRET.
 */
export function verifyRazorpayWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
