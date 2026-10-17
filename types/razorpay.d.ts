declare global {
  interface RazorpayPaymentResponse {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }

  interface RazorpayOptions {
    key: string | undefined;
    amount: number;
    currency: string;
    name: string;
    description: string;
    order_id: string;
    theme?: { color?: string };
    prefill?: { contact?: string };
    handler: (response: RazorpayPaymentResponse) => void | Promise<void>;
    modal?: { ondismiss?: () => void };
  }

  interface RazorpayPaymentFailedEvent {
    error: {
      code: string;
      description: string;
      source?: string;
      step?: string;
      reason?: string;
    };
  }

  interface RazorpayInstance {
    open: () => void;
    on: (event: "payment.failed", handler: (response: RazorpayPaymentFailedEvent) => void) => void;
  }

  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export {};
