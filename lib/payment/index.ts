import { getActiveProvider } from "../config";
import { createCashfreeOrder, refundCashfreeOrder, verifyCashfreeOrder } from "./cashfree";
import { createRazorpayOrder, refundRazorpayPayment, verifyRazorpayOrder } from "./razorpay";
import type { CreateOrderInput, CreateOrderOutput, RefundResult, VerifyResult } from "./types";

export type { CreateOrderInput, CreateOrderOutput, RefundResult, VerifyResult };
export { verifyCashfreeWebhookSignature } from "./cashfree";
export { verifyRazorpayWebhookSignature } from "./razorpay";

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
  const provider = getActiveProvider();
  if (provider === "cashfree") return createCashfreeOrder(input);
  return createRazorpayOrder(input);
}

export async function verifyOrder(provider: "cashfree" | "razorpay", providerOrderId: string): Promise<VerifyResult> {
  if (provider === "cashfree") return verifyCashfreeOrder(providerOrderId);
  return verifyRazorpayOrder(providerOrderId);
}

/**
 * Cashfree refunds by order id; Razorpay refunds by the captured payment's
 * own id — different enough that the dispatcher takes both and each
 * implementation uses what it needs. `paymentRef` is required for Razorpay
 * (there's nothing to refund without a captured payment id) but unused for
 * Cashfree.
 */
export async function refundOrder(input: {
  provider: "cashfree" | "razorpay";
  providerOrderId: string;
  paymentRef?: string;
  amountRupees: number;
}): Promise<RefundResult> {
  if (input.provider === "cashfree") return refundCashfreeOrder(input.providerOrderId, input.amountRupees);
  if (!input.paymentRef) throw new Error("No captured payment reference to refund.");
  return refundRazorpayPayment(input.paymentRef, input.amountRupees);
}
