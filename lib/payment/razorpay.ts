import crypto from "node:crypto";
import Razorpay from "razorpay";
import type { CreateOrderInput, RefundResult, VerifyResult } from "./types";

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
 *
 * Razorpay's order-creation API has no customer-phone field (unlike
 * Cashfree, which requires one up front) — the collected phone number is
 * used client-side instead, as Checkout's `prefill.contact`.
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

/** Bounds how long the banner's payment-detail enrichment ever waits on Razorpay — see fetchRazorpayPaymentDetails. */
const PAYMENT_DETAILS_FETCH_TIMEOUT_MS = 3000;

export interface RazorpayPaymentDetails {
  paymentId: string;
  /** acquirer_data.upi_transaction_id (the RRN/UTR) — confirmed against the installed razorpay SDK's own type declarations, not assumed; only ever populated for UPI payments, and not always immediately at capture time. */
  upiTxnId?: string;
  paidAmountRupees: number;
}

/**
 * GET /payments/:id — fetched separately from verifyRazorpayOrder's own
 * orders.fetchPayments call above because this is the only Razorpay
 * endpoint documented to return the full acquirer_data object (RRN/UTR
 * included); the order-level payments list isn't guaranteed to carry it.
 * Used by lib/payment-reconciliation.ts to print "Total paid"/"UPI Txn ID"
 * on the banner (lib/print/banner.ts) — nothing else depends on this.
 *
 * Best-effort and time-boxed: a slow or failing Razorpay call must never
 * block marking a job paid or printing it, so this never throws — a null
 * return just means "couldn't get the details this time," not an error.
 */
export async function fetchRazorpayPaymentDetails(paymentId: string): Promise<RazorpayPaymentDetails | null> {
  try {
    const razorpay = client();
    const payment = await Promise.race([
      razorpay.payments.fetch(paymentId),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Razorpay payment fetch timed out")), PAYMENT_DETAILS_FETCH_TIMEOUT_MS);
      }),
    ]);
    return {
      paymentId: payment.id,
      upiTxnId: payment.acquirer_data?.upi_transaction_id || undefined,
      paidAmountRupees: Number(payment.amount) / 100,
    };
  } catch (error) {
    console.warn(`Could not fetch Razorpay payment details for ${paymentId}:`, error);
    return null;
  }
}

/**
 * Real money movement, called only from the owner-gated app/api/admin/
 * refund route via lib/refund.ts's attemptRefund (never a Postgres RPC:
 * RAZORPAY_KEY_SECRET must never reach RLS-gated browser code). Refunds
 * the full captured amount; partial refunds aren't something this app
 * supports. `speed: "normal"` is explicit, not left to Razorpay's own
 * default — refunds here are a reviewed, owner-approved action on a
 * NORMAL schedule (5-7 business days), never instant/optimum speed, per
 * this feature's own requirement.
 *
 * Pre-checks the payment's own refund_status before attempting anything:
 * if Razorpay already considers this payment fully refunded (a previous
 * attempt whose own DB write failed — see complete_refund's own
 * "CRITICAL" log scenario — followed by a manual retry), this returns
 * success with `alreadyRefunded: true` instead of calling the refund
 * endpoint again, which Razorpay would otherwise just reject (there's
 * nothing left to refund). The catch block below is a second, defensive
 * layer for the same situation in case of a race between the pre-check and
 * the real call (another refund landing in between).
 */
export async function refundRazorpayPayment(paymentId: string, amountRupees: number): Promise<RefundResult> {
  const razorpay = client();

  try {
    const payment = await razorpay.payments.fetch(paymentId);
    if (payment.refund_status === "full") {
      return { refundId: await findExistingRazorpayRefundId(paymentId), alreadyRefunded: true };
    }
  } catch (checkError) {
    // Non-fatal — if the pre-check itself fails, fall through to the real
    // refund attempt below, which has its own already-refunded fallback.
    console.warn(`Could not pre-check refund status for payment ${paymentId}:`, checkError);
  }

  try {
    const refund = await razorpay.payments.refund(paymentId, { amount: Math.round(amountRupees * 100), speed: "normal" });
    return { refundId: refund.id };
  } catch (refundError) {
    if (isAlreadyRefundedError(refundError)) {
      return { refundId: await findExistingRazorpayRefundId(paymentId), alreadyRefunded: true };
    }
    throw refundError;
  }

  async function findExistingRazorpayRefundId(id: string): Promise<string> {
    try {
      const existing = await razorpay.payments.fetchMultipleRefund(id, { count: 1 });
      return existing.items[0]?.id ?? id;
    } catch {
      // Falls back to the payment id itself — still unique, still enough
      // for an owner reviewing the audit trail to find the right payment
      // in the Razorpay dashboard even without the exact refund id.
      return id;
    }
  }
}

/** Razorpay's own documented message for this case is "The payment has been fully refunded already" (BAD_REQUEST_ERROR) — matched loosely (refund + already/fully refunded) rather than on an exact string, since Razorpay doesn't document a stable machine-readable code for it. */
function isAlreadyRefundedError(error: unknown): boolean {
  const description = (error as { error?: { description?: string } } | undefined)?.error?.description
    ?? (error instanceof Error ? error.message : "");
  return /refund/i.test(description) && /(already|fully refunded)/i.test(description);
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
