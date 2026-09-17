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

/** Supabase Storage bucket final print-ready PDFs are uploaded to. */
export const SUPABASE_PRINT_BUCKET = process.env.SUPABASE_PRINT_BUCKET || "print-jobs";

/** CUPS printer name on the kiosk Pi. Leave unset to use the system default printer. */
export const PRINTER_NAME = process.env.PRINTER_NAME || "";

/**
 * Which physical kiosk this Pi's print agent is. Only relevant on the Pi
 * side — the website is shared across all kiosks and reads the kiosk id
 * from each job instead. Defaults to "oxway_01" (today's single kiosk).
 */
export const KIOSK_ID = process.env.KIOSK_ID || "oxway_01";

/** How often the Pi's print agent polls Supabase for newly-paid jobs, in ms. */
export const PRINT_AGENT_POLL_INTERVAL_MS = Number(process.env.PRINT_AGENT_POLL_INTERVAL_MS || 4000);

/**
 * Auto-delete timings (ROADMAP.md #4) — status-aware, not a flat cutoff.
 * Completed jobs (printed/print_failed/payment_failed/expired) get a short
 * buffer for reprint requests or complaint investigation; abandoned
 * pending_payment jobs get a longer safety-net window since nothing else
 * ever happens to them.
 */
export const TERMINAL_JOB_RETENTION_HOURS = 6;
export const ABANDONED_JOB_RETENTION_HOURS = 24;

/** Basic abuse protection on /api/create-order (ROADMAP.md #13). Tunable — not prescribed by the roadmap. */
export const CREATE_ORDER_RATE_LIMIT_MAX = 5;
export const CREATE_ORDER_RATE_LIMIT_WINDOW_SECONDS = 60;

/** How long an identical (file + settings + price) resubmission is treated as a duplicate, not a new order. */
export const DUPLICATE_ORDER_WINDOW_SECONDS = 60;

/**
 * Heartbeat monitoring (ROADMAP.md #8). Reuses kiosk_status.updated_at as
 * the heartbeat signal instead of a dedicated column — the print agent
 * touches it on its own timer, independent of the job-polling loop, so a
 * kiosk with zero jobs for hours still reads as alive. Touched every minute
 * rather than every poll cycle (default 4s) to keep the write volume against
 * Supabase's free-tier request quota reasonable — heartbeat doesn't need
 * job-polling precision.
 */
export const KIOSK_HEARTBEAT_INTERVAL_MS = 60_000;
/** A kiosk silent longer than this is flagged stale — generous enough (10x the heartbeat interval) to absorb a transient blip without a false alarm. */
export const KIOSK_SILENT_THRESHOLD_MINUTES = 10;

/** Where low-supply / kiosk-silent alerts (ROADMAP.md #8) go — the owner, not a customer. No real SMS/WhatsApp provider is wired yet (see lib/notify/console.ts), so this only matters once one is. */
export const OWNER_ALERT_PHONE = process.env.OWNER_ALERT_PHONE || "";
