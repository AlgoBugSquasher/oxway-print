export interface CreateOrderInput {
  jobId: string;
  amountRupees: number;
  fileName: string;
  /** Customer's phone number, collected at checkout — see ROADMAP.md #1. */
  phone: string;
}

/** What the frontend needs to actually collect payment, shaped per provider. */
export type CreateOrderOutput =
  | {
      provider: "cashfree";
      providerOrderId: string;
      paymentSessionId: string;
    }
  | {
      provider: "razorpay";
      providerOrderId: string;
      keyId: string;
      amount: number;
    };

export interface VerifyResult {
  paid: boolean;
  /** Provider-side reference for the successful payment, if any (payment id / utr). */
  paymentRef?: string;
}

export interface RefundResult {
  refundId: string;
  /**
   * True when this call discovered the money had ALREADY moved at the
   * gateway (a previous attempt whose own DB write failed, retried later)
   * rather than this call being the one that actually moved it — see
   * lib/payment/razorpay.ts / lib/payment/cashfree.ts's own pre-refund
   * checks. lib/refund.ts treats this exactly like a fresh success (the
   * money is refunded either way) but records it in the audit trail.
   */
  alreadyRefunded?: boolean;
}
