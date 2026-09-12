import { getActiveProvider } from "../config";
import { createCashfreeOrder, verifyCashfreeOrder } from "./cashfree";
import { createRazorpayOrder, verifyRazorpayOrder } from "./razorpay";
import type { CreateOrderInput, CreateOrderOutput, VerifyResult } from "./types";

export type { CreateOrderInput, CreateOrderOutput, VerifyResult };
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
