export interface CreateOrderInput {
  jobId: string;
  amountRupees: number;
  fileName: string;
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
