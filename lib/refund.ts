import { refundOrder } from "./payment";
import { supabaseAdmin } from "./supabase-admin";
import type { PrintJobRecord } from "./store";

export type RefundAttemptResult =
  | { ok: true; refundId: string }
  | { ok: false; reason: "already_refunded" | "no_captured_payment" | "staff_job" };

/** Who/what triggered this refund — undefined (every field) for print-agent's own automatic refund-on-print-failure, which has no human actor. Threaded through to record_refund() purely for the audit entry (see supabase/schema.sql §11); never used for authorization here — the caller is responsible for that, same as before. */
export interface RefundActor {
  userId?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

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
export async function attemptRefund(job: PrintJobRecord, actor: RefundActor = {}): Promise<RefundAttemptResult> {
  // Checked FIRST, before even the already-refunded guard below — a free
  // staff print never had any money move at a gateway in the first place
  // (no providerOrderId, no captured payment), so this must never reach
  // refundOrder, which would otherwise call Razorpay/Cashfree with
  // meaningless/empty arguments. `provider` is still set to a real gateway
  // value on a staff job (see lib/store.ts's own comment on why), so this
  // check on `paymentMethod` — not `provider` — is what actually protects
  // this: provider alone would NOT catch a staff job here.
  if (job.paymentMethod === "staff") return { ok: false, reason: "staff_job" };
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
  // treated very differently. record_refund() marks refunded_at AND writes
  // the audit entry in one Postgres transaction (requirement #4: "write the
  // audit entry in the same transaction if possible" — the gateway call
  // above can never itself be part of that transaction, but everything on
  // the DB side of it now genuinely is). If this call fails, the job would
  // still read as un-refunded and a retry could attempt a second real
  // refund, so a failure here is logged as a distinct, loud, actionable
  // error rather than silently swallowed — but the caller still gets
  // `ok: true`, since the money already moved; that's the fact that
  // actually matters here.
  try {
    const { error } = await supabaseAdmin().rpc("record_refund", {
      p_job_id: job.id,
      p_refund_id: refund.refundId,
      p_actor_user_id: actor.userId ?? null,
      p_actor_role: actor.role ?? null,
      p_ip: actor.ip ?? null,
      p_user_agent: actor.userAgent ?? null,
    });
    if (error) throw new Error(error.message);
  } catch (updateError) {
    console.error(
      `[CRITICAL] Refund ${refund.refundId} succeeded at ${job.provider} for job ${job.id} but marking it refunded in the DB failed — ` +
      `manually verify in the gateway dashboard and set refunded_at, or a retry may attempt a second refund:`,
      updateError
    );
  }

  return { ok: true, refundId: refund.refundId };
}
