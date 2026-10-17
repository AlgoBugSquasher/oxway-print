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

/**
 * Max accepted upload size — enforced in /api/create-upload-url (before
 * issuing a signed URL) and re-checked in /api/create-order against the
 * actual downloaded bytes (the client's declared size is never trusted
 * alone). 50MB rather than the old 25MB: that number was never a technical
 * ceiling, just a round one picked before uploads went direct-to-storage —
 * now that the file never passes through a Vercel serverless function's
 * request body (see lib/store.ts's temp-upload functions), there's no
 * platform-imposed reason to keep it lower.
 */
export const MAX_UPLOAD_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Max pages app/api/create-order accepts in the final uploaded PDF (after
 * extractSelectedPages re-derives the real page count server-side — the
 * client's own claim is never trusted). Matches MAX_TOTAL_PAGES_PER_BASKET
 * in lib/hooks/useFileBasket.ts, which bounds this client-side before a
 * customer ever gets to checkout — this is the authoritative copy of that
 * same limit, independently enforced, the same relationship
 * MAX_UPLOAD_FILE_SIZE_BYTES above already has with that hook's own
 * MAX_FILE_SIZE_BYTES.
 */
export const MAX_UPLOAD_PAGE_COUNT = 300;

/**
 * How long a temporary direct-to-storage upload (lib/store.ts's
 * tempUploadStoragePath, under the "uploads/" prefix) can sit unclaimed
 * before the cleanup cron sweeps it as an orphan — e.g. the customer
 * uploaded the file, then closed the tab before /api/create-order ever
 * ran. Short, not matched to TERMINAL_JOB_RETENTION_HOURS above: an orphan
 * was never a real order to begin with, so there's no reprint/complaint
 * window worth holding it for.
 */
export const TEMP_UPLOAD_STALE_HOURS = 1;

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
 * Free staff/owner prints (app/api/staff-print) — abuse limits, both
 * enforced server-side (never trust the client). MAX_PAGES_PER_STAFF_JOB is
 * a single request's own page count, checked directly against the real
 * extracted page count (no race risk — it's one job's own data, not a
 * shared counter). MAX_STAFF_DAILY_PAGES is a running total across however
 * many jobs one staff user creates in a day, so it's enforced atomically
 * inside the create_staff_print_job() Postgres function (see that
 * migration) rather than read-then-written here — two concurrent staff
 * prints must never both slip past the cap.
 */
export const MAX_PAGES_PER_STAFF_JOB = 100;
export const MAX_STAFF_DAILY_PAGES = 500;

/** Rate limit on /api/staff-print — keyed by the signed-in user's id (not IP, unlike create-order's anonymous customers), reusing the same atomic increment_rate_limit() RPC. Looser than the customer limit: a legitimate staff member printing several real documents in a minute is normal, not abuse. */
export const STAFF_PRINT_RATE_LIMIT_MAX = 20;
export const STAFF_PRINT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Basic abuse protection on /api/admin/login (and the prototype passcode
 * login, which shares the same IP key) — reuses the same atomic
 * increment_rate_limit() RPC, keyed by BOTH the attempted email and the
 * caller's IP independently, so this blunts both "one IP hammering many
 * accounts" and "one account hammered from many IPs." This is deliberately
 * loose, generic abuse mitigation, not the real per-account lockout with
 * its own cooldown/messaging — that's a separate, larger feature; see
 * ROADMAP-style account-hardening notes. A legitimate user mistyping their
 * password a few times must never get rate-limited by this.
 */
export const LOGIN_RATE_LIMIT_MAX = 10;
export const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60;

export const COLLECT_JOB_RATE_LIMIT_MAX = 10;
export const COLLECT_JOB_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Heartbeat monitoring (ROADMAP.md #8). Writes to kiosk_status.last_seen_at,
 * a dedicated column separate from updated_at (which also moves on every
 * print-counter update) — the print agent touches it on its own timer,
 * independent of the job-polling loop, so a kiosk with zero jobs for hours
 * still reads as alive. Every 20s so the website's own-online indicator
 * (ONLINE_THRESHOLD_SECONDS below) can react within well under a minute.
 */
export const KIOSK_HEARTBEAT_INTERVAL_MS = 20_000;
/** A kiosk silent longer than this is flagged stale for the owner-alert cron — generous enough to absorb a transient blip without a false alarm. */
export const KIOSK_SILENT_THRESHOLD_MINUTES = 10;
/**
 * How stale kiosk_status.last_seen_at can be before the customer-facing
 * website treats the kiosk as offline. 3x the heartbeat interval above —
 * enough to absorb one or two missed beats without flapping the banner on a
 * momentary network blip.
 */
export const ONLINE_THRESHOLD_SECONDS = 60;

/** Where low-supply / kiosk-silent alerts (ROADMAP.md #8) go — the owner, not a customer. No real SMS/WhatsApp provider is wired yet (see lib/notify/console.ts), so this only matters once one is. */
export const OWNER_ALERT_PHONE = process.env.OWNER_ALERT_PHONE || "";

export type NotifyProviderName = "console" | "msg91";

/**
 * Which notify provider is actually live — same toggle pattern as
 * getActiveProvider() above for payments. Defaults to "console" (logs
 * instead of sending) rather than throwing when unset, unlike the payment
 * toggle: until real MSG91 credentials exist there's nothing to flip this
 * to yet, and the whole point is that nothing about re-enabling WhatsApp
 * notifications later should require touching code — just set
 * NOTIFY_PROVIDER=msg91 plus the MSG91_* vars below once there's a real
 * account and an approved WhatsApp template.
 */
export function getActiveNotifyProvider(): NotifyProviderName {
  return process.env.NOTIFY_PROVIDER === "msg91" ? "msg91" : "console";
}

/**
 * MSG91 WhatsApp send API — see lib/notify/msg91.ts for the request shape
 * built from these. NEEDS VERIFICATION once a real account/template
 * exists; see that file's own docstring.
 */
export const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || "";
export const MSG91_WHATSAPP_TEMPLATE_NAME = process.env.MSG91_WHATSAPP_TEMPLATE_NAME || "";
export const MSG91_WHATSAPP_SENDER = process.env.MSG91_WHATSAPP_SENDER || "";

/**
 * Shared secret the print agent authenticates with when calling
 * app/api/agent/notify — the Pi is the only caller, so a simple bearer
 * token (same pattern as CRON_SECRET on the cron routes) is enough; there's
 * no browser/RLS context on that side to issue a real session to.
 */
export const AGENT_API_SECRET = process.env.AGENT_API_SECRET || "";

/**
 * Remote "Update kiosk" command (Pi-only) — the branch the print agent
 * fast-forwards to on an `update` command. Deliberately read from this
 * Pi's own env, never from the command row itself — an admin can only ever
 * trigger "pull whatever the agent is already configured to trust," never
 * point a kiosk at an arbitrary ref. See print-agent/kiosk-update.ts.
 */
export const UPDATE_BRANCH = process.env.UPDATE_BRANCH || "main";

/**
 * Non-WhatsApp alert channels (low-supply, kiosk-offline) — see lib/alerts/.
 * Both optional: a channel with no token/key configured just skips itself
 * (logged once via console.warn, same fail-open convention as
 * OWNER_ALERT_PHONE above), never throws.
 */
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
export const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "alerts@oxway.app";

/** Hours between repeat reminders for a still-unresolved alert — see lib/alerts/index.ts's evaluateAlert. */
export const ALERT_REMINDER_HOURS = 6;
