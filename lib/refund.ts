import { refundOrder } from "./payment";
import { updateJob, type PrintJobRecord } from "./store";

export type RefundAttemptResult =
  | { ok: true; refundId: string }
  | { ok: false; reason: "already_refunded" | "no_captured_payment" };

/**
 * The actual refund execution, shared between app/api/admin/refund (a human
 * clicking "Refund") and print-agent/index.ts (ROADMAP.md §10 — automatic,
 * the instant a job hits print_failed). Callers are responsible for their
 * own authorization/status checks first — this function only owns the
 * money-movement part and its own idempotency guard.
 *
 * Safe to call more than once on the same job: the already-refunded check
 * makes a second call a no-op instead of a second real refund, which
 * matters because print-agent calls this unconditionally on every failure
 * without knowing whether something already refunded this job.
 */
export async function attemptRefund(job: PrintJobRecord): Promise<RefundAttemptResult> {
  if (job.refundedAt) return { ok: false, reason: "already_refunded" };
  if (job.provider === "razorpay" && !job.providerMeta?.paymentRef) {
    return { ok: false, reason: "no_captured_payment" };
  }

  const refund = await refundOrder({
    provider: job.provider,
    providerOrderId: job.providerOrderId,
    paymentRef: job.providerMeta?.paymentRef,
    amountRupees: job.totalPrice,
  });

  // The refund has now genuinely happened at the gateway — from here on, a
  // failure is a bookkeeping problem, not a failed refund, and must be
  // treated very differently. If this write fails, the job would still read
  // as un-refunded and a retry could attempt a second real refund, so a
  // failure here is logged as a distinct, loud, actionable error rather than
  // silently swallowed — but the caller still gets `ok: true`, since the
  // money already moved; that's the fact that actually matters here.
  try {
    await updateJob(job.id, { refundedAt: new Date().toISOString() });
  } catch (updateError) {
    console.error(
      `[CRITICAL] Refund ${refund.refundId} succeeded at ${job.provider} for job ${job.id} but marking it refunded in the DB failed — ` +
      `manually verify in the gateway dashboard and set refunded_at, or a retry may attempt a second refund:`,
      updateError
    );
  }

  return { ok: true, refundId: refund.refundId };
}
