import { OWNER_ALERT_PHONE } from "../config";
import { shortRequestId } from "../request-id";
import { consoleProvider } from "./console";
import type { NotifyProvider } from "./types";

export type { NotifyProvider } from "./types";

/** No real provider wired up yet — see the note in ./console.ts. */
function activeProvider(): NotifyProvider {
  return consoleProvider;
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
 * Trigger 2 of 3 from ROADMAP.md #2. Called from print-agent/index.ts right
 * after a job leaves the CUPS queue.
 */
export async function notifyPrintCompleted(job: { id: string; phoneNumber: string }): Promise<void> {
  await activeProvider().send(
    job.phoneNumber,
    `OXWAY: Your print is ready for pickup! Request ID: ${shortRequestId(job.id)}.`
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
