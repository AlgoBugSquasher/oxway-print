import { PAYMENT_TIMEOUT_SECONDS } from "./config";
// ROADMAP.md §2 (notifications) is disabled for v2.5 — the ticket-code
// system (§21-23) is the customer-facing replacement. lib/notify/ and
// lib/eta.ts both still port forward untouched; only this call site is
// commented out, so re-enabling §2 later is uncommenting these two lines.
// import { estimateMinutesUntilReady } from "./eta";
// import { notifyPaymentConfirmed } from "./notify";
import { verifyOrder } from "./payment";
import { claimJobAsPaid, expireJobIfPending, getJob, type PrintJobRecord } from "./store";

/**
 * Single source of truth for moving a job out of `pending_payment` — either
 * to `paid` (gateway confirms it) or `expired` (timed out). Called from two
 * independent places that can race on the very same job: the customer's own
 * browser polling (app/api/verify-payment) and the scheduled recheck that
 * runs regardless of whether any browser is open (app/api/cron/recheck-payments,
 * ROADMAP.md #9).
 *
 * The actual status flip goes through claimJobAsPaid / expireJobIfPending,
 * both atomic `UPDATE ... WHERE status = 'pending_payment'`s — so if both
 * callers hit this for the same job at nearly the same instant, only one of
 * them actually wins the transition. Only that winner sends the
 * payment-confirmed SMS/WhatsApp, which is what stops the customer getting
 * texted twice (see ROADMAP.md §11).
 */
export async function reconcilePendingPayment(job: PrintJobRecord): Promise<PrintJobRecord> {
  if (job.status !== "pending_payment") return job;

  const ageSeconds = (Date.now() - new Date(job.createdAt).getTime()) / 1000;
  if (ageSeconds > PAYMENT_TIMEOUT_SECONDS) {
    return (await expireJobIfPending(job.id)) ?? (await getJob(job.id)) ?? job;
  }

  const result = await verifyOrder(job.provider, job.providerOrderId);
  if (!result.paid) return job;

  const claimed = await claimJobAsPaid(job.id, { ...job.providerMeta, paymentRef: result.paymentRef || "" });
  if (!claimed) {
    // Someone else (the other caller) already won the claim — reflect their outcome, don't notify again.
    return (await getJob(job.id)) ?? job;
  }

  // Disabled for v2.5 — see the §2 note in this file's imports above.
  // try {
  //   const etaMinutes = await estimateMinutesUntilReady(claimed);
  //   await notifyPaymentConfirmed(claimed, etaMinutes);
  // } catch (notifyError) {
  //   // A notification/ETA failure must never undo or mask an already-successful payment claim.
  //   console.error("notifyPaymentConfirmed failed:", notifyError);
  // }
  return claimed;
}
