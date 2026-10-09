import { getActiveNotifyProvider, OWNER_ALERT_PHONE } from "../config";
import { shortRequestId } from "../request-id";
import { consoleProvider } from "./console";
import { msg91Provider } from "./msg91";
import type { NotifyProvider } from "./types";

export type { NotifyProvider } from "./types";

/** Picks the provider per NOTIFY_PROVIDER (lib/config.ts) — console until that's explicitly set to "msg91", same toggle pattern lib/payment/ uses for the gateway. */
function activeProvider(): NotifyProvider {
  return getActiveNotifyProvider() === "msg91" ? msg91Provider : consoleProvider;
}

/**
 * Trigger 1 of 3 from ROADMAP.md #2. Called only from
 * lib/payment-reconciliation.ts, and only by whichever caller actually won
 * the atomic paid-transition — see that file for why, and ROADMAP.md §11
 * for the duplicate-notification race this avoids. `etaMinutes` is the
 * ROADMAP.md #3 estimate, computed by the caller at the moment of
 * confirmation — optional so a failure computing it never blocks the
 * "payment confirmed" text itself from going out.
 */
export async function notifyPaymentConfirmed(job: { id: string; phoneNumber: string }, etaMinutes?: number): Promise<void> {
  const etaText = etaMinutes !== undefined ? ` Ready in about ${etaMinutes} min.` : "";
  await activeProvider().send(
    job.phoneNumber,
    `OXWAY: Payment confirmed! Your Request ID is ${shortRequestId(job.id)}.${etaText} We'll text you again the moment it's printed.`
  );
}

/**
 * Called from app/api/agent/notify (the print agent's terminal-state ping,
 * see that route) once a job reaches `printed` — only when the job opted
 * into WhatsApp updates, see that route's own notify_opt_in check. Leads
 * with the ticket code rather than the Request ID, since that's the actual
 * v2.5 pickup mechanism (ROADMAP.md §21-23) — the customer matches this
 * same code against the kiosk screen, not the Request ID.
 */
export async function notifyPrintCompleted(job: { id: string; phoneNumber: string; ticketNumber?: number }): Promise<void> {
  const pickupCode = job.ticketNumber != null ? `#${String(job.ticketNumber).padStart(3, "0")}` : shortRequestId(job.id);
  await activeProvider().send(
    job.phoneNumber,
    `OXWAY: Your print is ready! Show pickup code ${pickupCode} at the kiosk to collect it.`
  );
}

/**
 * Called from the same place as notifyPrintCompleted above, for the other
 * terminal state that opted-in customers hear about: a print that failed
 * and was successfully auto-refunded (lib/refund.ts). Deliberately NOT
 * sent when the refund itself also failed — see app/api/agent/notify's own
 * comment for why that case is left to staff follow-up instead of a
 * WhatsApp message that would be claiming something that isn't true yet.
 */
export async function notifyPrintFailedRefunded(job: { id: string; phoneNumber: string }): Promise<void> {
  await activeProvider().send(
    job.phoneNumber,
    `OXWAY: Sorry, your print couldn't be completed. Your payment has been refunded — Request ID: ${shortRequestId(job.id)}. See kiosk staff if you'd like to try again.`
  );
}

/**
 * Trigger 3 of 3 from ROADMAP.md #2 — "kiosk trouble", alerts the owner, not
 * a customer. Reuses the same pipe as the other two triggers rather than a
 * separate system, per the roadmap's own framing. No-ops with a console
 * warning if OWNER_ALERT_PHONE isn't set, rather than sending to an empty
 * string — see ROADMAP.md #8.
 */
async function notifyOwner(message: string): Promise<void> {
  if (!OWNER_ALERT_PHONE) {
    console.warn(`[notify] OWNER_ALERT_PHONE not set — dropping owner alert: ${message}`);
    return;
  }
  await activeProvider().send(OWNER_ALERT_PHONE, message);
}

/** Called from lib/kiosk-stats.ts when a kiosk's tray or cartridge first crosses the low-supply threshold. */
export async function notifyLowSupply(kioskId: string, item: "tray" | "cartridge", current: number, max: number): Promise<void> {
  const label = item === "tray" ? "paper tray" : "toner cartridge";
  await notifyOwner(`OXWAY: Kiosk "${kioskId}" is low on its ${label} — ${current}/${max} (${Math.round((current / max) * 100)}%). Refill soon.`);
}

/** Called from app/api/cron/check-kiosk-heartbeats when a kiosk hasn't been seen in longer than KIOSK_SILENT_THRESHOLD_MINUTES. */
export async function notifyKioskSilent(kioskId: string, minutesSinceLastSeen: number): Promise<void> {
  await notifyOwner(`OXWAY: Kiosk "${kioskId}" hasn't checked in for ${minutesSinceLastSeen} minutes — the print agent may be down.`);
}
