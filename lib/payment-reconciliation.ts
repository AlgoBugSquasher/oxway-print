import { PAYMENT_TIMEOUT_SECONDS } from "./config";
// ROADMAP.md §2 (notifications) is disabled for v2.5 — the ticket-code
// system (§21-23) is the customer-facing replacement. lib/notify/ and
// lib/eta.ts both still port forward untouched; only this call site is
// commented out, so re-enabling §2 later is uncommenting these two lines.
// import { estimateMinutesUntilReady } from "./eta";
// import { notifyPaymentConfirmed } from "./notify";
import { verifyOrder } from "./payment";
import { fetchRazorpayPaymentDetails } from "./payment/razorpay";
import { claimJobAsPaid, expireJobIfPending, getJob, updateJob, type PrintJobRecord } from "./store";

/**
 * Best-effort enrichment of a Razorpay job with payment-gateway detail that
 * verifyOrder's own list-based check doesn't reliably carry — specifically
 * the UPI transaction id (payment.acquirer_data.upi_transaction_id, see
 * fetchRazorpayPaymentDetails) — printed on the banner by
 * lib/print/banner.ts's buildPaymentLineTexts; nothing else depends on it.
 *
 * Called from two places:
 *   - reconcilePendingPayment below, right after claimJobAsPaid succeeds.
 *   - print-agent/index.ts, once more right before building the banner, in
 *     case the UPI transaction id specifically wasn't populated yet the
 *     first time (Razorpay doesn't always have acquirer_data settled the
 *     instant a payment is captured).
 *
 * Never throws and never blocks its caller: a slow/failed Razorpay call (or
 * a non-Razorpay job, or a job with nothing left to fetch) just returns the
 * job unchanged, and the banner's payment lines fall back accordingly.
 */
export async function enrichJobWithRazorpayPaymentDetails(job: PrintJobRecord): Promise<PrintJobRecord> {
  // A free staff print's `provider` column is still set to a real gateway
  // value (see lib/store.ts's own comment on why) even though it never had
  // one — check paymentMethod first so this never even considers calling
  // out to Razorpay for a job that was never a Razorpay payment. This is
  // the only guard that actually matters here, since job.paymentId and
  // job.providerMeta?.paymentRef are both always empty for a staff job
  // regardless, which the check two lines down would already catch safely
  // — this one is just more honest about why.
  if (job.paymentMethod === "staff") return job;
  if (job.provider !== "razorpay") return job;
  const paymentId = job.paymentId || job.providerMeta?.paymentRef;
  if (!paymentId) return job;

  try {
    const details = await fetchRazorpayPaymentDetails(paymentId);
    if (!details) return job;

    const patch: Partial<PrintJobRecord> = {};
    if (!job.paymentId) patch.paymentId = details.paymentId;
    if (!job.upiTxnId && details.upiTxnId) patch.upiTxnId = details.upiTxnId;
    if (job.paidAmount == null) patch.paidAmount = details.paidAmountRupees;
    if (Object.keys(patch).length === 0) return job;

    return (await updateJob(job.id, patch)) ?? job;
  } catch (error) {
    console.warn(`Could not enrich job ${job.id} with Razorpay payment details:`, error);
    return job;
  }
}

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

  // Best-effort — never undoes or masks the already-successful claim above; see enrichJobWithRazorpayPaymentDetails's own comment.
  return enrichJobWithRazorpayPaymentDetails(claimed);
}
