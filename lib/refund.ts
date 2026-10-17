import { refundOrder } from "./payment";
import { supabaseAdmin } from "./supabase-admin";

/** Who approved this refund — threaded through purely for the audit entries claim/complete/fail_refund write; never used for authorization here, same as before — the caller (app/api/admin/refund) is responsible for that. */
export interface RefundActor {
  userId?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type RefundAttemptResult =
  | { ok: true; refundId: string; amountRupees: number; alreadyRefundedAtProvider: boolean }
  // `reason` is already a clear, specific message — either from
  // claim_refund_for_processing's own exception (job not found, already
  // processing, already refunded, reprinted since failing, ...) or from
  // the gateway call itself failing. Callers can show it directly.
  | { ok: false; reason: string };

interface ClaimedJobRow {
  id: string;
  status: string;
  total_price: number;
  provider: "cashfree" | "razorpay";
  provider_order_id: string;
  provider_meta: Record<string, string> | null;
  payment_method: "razorpay" | "cashfree" | "staff" | null;
}

/**
 * Owner-reviewed, one-job-at-a-time refund — called from app/api/admin/
 * refund for both a single "Refund" click and each job in a "Refund
 * selected" bulk batch (the route just calls this once per jobId, never in
 * parallel, so this never has to worry about two calls for DIFFERENT jobs
 * racing each other — only the atomic claim below has to worry about two
 * calls for the SAME job racing, which is exactly what it exists to solve).
 *
 * No longer called automatically by print-agent/index.ts on a print
 * failure (that auto-refund call has been removed) — a failed, previously-
 * paid job instead lands in refund_status = 'pending' via a database
 * trigger (see supabase/schema.sql's set_print_job_refund_pending), and
 * this function is the ONLY way any of those ever actually get refunded,
 * one owner-approved click at a time.
 *
 * Three steps, in order:
 *   1. Atomically claim the job (pending|failed -> processing), re-checking
 *      its CURRENT state server-side — refuses a double click/two tabs, and
 *      refuses a job that's since been reprinted or already refunded, with
 *      a specific reason either way (requirement: "re-check the job's
 *      current state and refuse if it actually printed after the failure,
 *      print the reason clearly").
 *   2. Call the payment gateway for the exact amount this job was actually
 *      charged, using the SAME provider the payment used, at normal speed
 *      (see lib/payment/razorpay.ts / lib/payment/cashfree.ts).
 *   3. Resolve the claim: complete_refund on success (including a success
 *      the gateway reports as "already refunded" — see
 *      RefundActor/alreadyRefundedAtProvider), fail_refund on a genuine
 *      gateway failure (never leaves a job stuck in 'processing' forever).
 */
export async function attemptRefund(jobId: string, actor: RefundActor = {}): Promise<RefundAttemptResult> {
  const admin = supabaseAdmin();

  const { data: claimedRows, error: claimError } = await admin.rpc("claim_refund_for_processing", { p_job_id: jobId });
  if (claimError) return { ok: false, reason: claimError.message };
  const job = (claimedRows as ClaimedJobRow[] | null)?.[0];
  if (!job) return { ok: false, reason: "Could not claim this job for refunding." };

  // Defensive only — the trigger that sets refund_status = 'pending' never
  // fires for a staff job (payment_method === "staff"), so
  // claim_refund_for_processing's own WHERE refund_status IN ('pending',
  // 'failed') should already make this unreachable. Checked here anyway
  // rather than trusted by omission, same reasoning this check always had.
  if (job.payment_method === "staff") {
    await failClaim(admin, jobId, "Staff job — nothing to refund.", actor);
    return { ok: false, reason: "This was a free staff print — nothing was charged, so there's nothing to refund." };
  }
  if (job.provider === "razorpay" && !job.provider_meta?.paymentRef) {
    await failClaim(admin, jobId, "No captured payment reference.", actor);
    return { ok: false, reason: "No captured payment reference on this job — nothing to refund." };
  }

  try {
    const refund = await refundOrder({
      provider: job.provider,
      providerOrderId: job.provider_order_id,
      paymentRef: job.provider_meta?.paymentRef,
      amountRupees: job.total_price,
    });

    const { error: completeError } = await admin.rpc("complete_refund", {
      p_job_id: jobId,
      p_refund_id: refund.refundId,
      p_already_refunded_at_provider: refund.alreadyRefunded ?? false,
      p_actor_user_id: actor.userId ?? null,
      p_actor_role: actor.role ?? null,
      p_ip: actor.ip ?? null,
      p_user_agent: actor.userAgent ?? null,
    });
    if (completeError) {
      // The refund has now genuinely happened at the gateway — a failure
      // here is a bookkeeping problem, not a failed refund, so this still
      // reports ok: true (the money already moved, which is the fact that
      // actually matters) but logs loudly: the job is stuck showing
      // refund_status = 'processing' until someone manually fixes it,
      // and a naive retry could attempt a second real refund.
      console.error(
        `[CRITICAL] Refund ${refund.refundId} succeeded at ${job.provider} for job ${jobId} but marking it refunded in the DB failed — ` +
        `manually verify in the gateway dashboard and run complete_refund, or a retry may attempt a second refund:`,
        completeError
      );
    }
    return { ok: true, refundId: refund.refundId, amountRupees: Number(job.total_price), alreadyRefundedAtProvider: refund.alreadyRefunded ?? false };
  } catch (gatewayError) {
    // gatewayError.message never contains a secret (RAZORPAY_KEY_SECRET /
    // CASHFREE_SECRET_KEY are never interpolated into any thrown error in
    // lib/payment/*) — safe to log and to store in refund_error.
    const message = gatewayError instanceof Error ? gatewayError.message : "Refund failed at the payment provider.";
    await failClaim(admin, jobId, message, actor);
    return { ok: false, reason: message };
  }
}

async function failClaim(admin: ReturnType<typeof supabaseAdmin>, jobId: string, message: string, actor: RefundActor): Promise<void> {
  const { error } = await admin.rpc("fail_refund", {
    p_job_id: jobId,
    p_error: message,
    p_actor_user_id: actor.userId ?? null,
    p_actor_role: actor.role ?? null,
    p_ip: actor.ip ?? null,
    p_user_agent: actor.userAgent ?? null,
  });
  if (error) console.error(`[CRITICAL] fail_refund itself failed for job ${jobId} (refund_status is now stuck at 'processing'):`, error);
}

/**
 * One summary audit entry for a "Refund selected" bulk click — separate
 * from the per-job entries complete_refund/fail_refund already write for
 * each job in the batch. Only worth calling for a genuine multi-job
 * submission; app/api/admin/refund skips this for a single-job request
 * (that job's own per-job entry already says everything there is to say).
 */
export async function recordBulkRefundAction(input: {
  jobIds: string[];
  totalRupees: number;
  succeeded: number;
  failed: number;
  actor: RefundActor;
}): Promise<void> {
  const { error } = await supabaseAdmin().rpc("record_refund_bulk_action", {
    p_job_ids: input.jobIds,
    p_total: input.totalRupees,
    p_succeeded: input.succeeded,
    p_failed: input.failed,
    p_actor_user_id: input.actor.userId ?? null,
    p_actor_role: input.actor.role ?? null,
    p_ip: input.actor.ip ?? null,
    p_user_agent: input.actor.userAgent ?? null,
  });
  if (error) console.error("record_refund_bulk_action failed:", error);
}
