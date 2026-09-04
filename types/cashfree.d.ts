declare module "@cashfreepayments/cashfree-js" {
  type CashfreeResult = {
    error?: { message?: string };
  };

  type CashfreeClient = {
    checkout: (options: {
      paymentSessionId: string;
      redirectTarget: "_modal";
    }) => Promise<CashfreeResult>;
  };

  export function load(options: { mode: "sandbox" | "production" }): Promise<CashfreeClient | null>;
}