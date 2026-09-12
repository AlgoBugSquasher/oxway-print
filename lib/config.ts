export type PaymentProvider = "cashfree" | "razorpay";

/**
 * Which gateway is "live" right now. Flip this one env var the moment either
 * Cashfree or Razorpay finishes KYC — no code changes needed.
 *   PAYMENT_PROVIDER=cashfree | razorpay
 */
export function getActiveProvider(): PaymentProvider {
  const value = (process.env.PAYMENT_PROVIDER || "").toLowerCase();
  if (value === "razorpay") return "razorpay";
  if (value === "cashfree") return "cashfree";
  throw new Error(
    "Set PAYMENT_PROVIDER=cashfree or PAYMENT_PROVIDER=razorpay in .env.local once a gateway is approved."
  );
}

/** Public base URL, used for gateway return/notify URLs. Not required for the polling flow. */
export const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

/** How long a kiosk checkout session stays valid before we give up, in seconds. */
export const PAYMENT_TIMEOUT_SECONDS = Number(process.env.PAYMENT_TIMEOUT_SECONDS || 300);

/** CUPS printer name on the kiosk Pi. Leave unset to use the system default printer. */
export const PRINTER_NAME = process.env.PRINTER_NAME || "";

/** Supabase Storage bucket final print-ready PDFs are uploaded to. */
export const SUPABASE_PRINT_BUCKET = process.env.SUPABASE_PRINT_BUCKET || "print-jobs";

/** How often the Pi's print agent polls Supabase for newly-paid jobs, in ms. */
export const PRINT_AGENT_POLL_INTERVAL_MS = Number(process.env.PRINT_AGENT_POLL_INTERVAL_MS || 4000);
