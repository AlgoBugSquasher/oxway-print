import { recordCompletedPrint } from "./kiosk-stats";
import { physicalSheetsForJob } from "./print/sheets";
import { getJob } from "./store";
import { supabaseAdmin } from "./supabase-admin";

export interface MarkPrintedActor {
  userId?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type MarkPrintedResult =
  | { ok: true }
  // `reason` is already a clear, specific message from the RPC's own
  // exception (not print_failed, already refunded, refund processing, job
  // not found) — callers can show it directly, same convention as
  // lib/refund.ts's RefundAttemptResult.
  | { ok: false; reason: string };

/**
 * The corrective action for a job that actually printed but got marked
 * print_failed anyway (e.g. the fixed-timeout bug — see
 * lib/print/ready-timing.ts's STUCK_JOB_TIMEOUT_CONFIG). Two steps:
 *
 *   1. mark_job_printed_no_refund_needed (supabase/schema.sql) does the
 *      ONE authoritative, atomically-guarded state flip — print_failed ->
 *      printed, refund_status -> not_needed. Its own WHERE clause is what
 *      actually enforces "impossible to use on a job that was already
 *      refunded," not this function.
 *   2. Once that succeeds, this calls the SAME recordCompletedPrint
 *      (lib/kiosk-stats.ts) the print agent's own success path already
 *      uses — the exact revenue/print_orders/tray-cartridge bookkeeping
 *      this job missed the first time, reusing that one code path rather
 *      than a second copy of it. Passing jobId lets print_orders' own
 *      unique index on job_id catch a double-call defensively, though the
 *      RPC's atomic guard already means this can only ever genuinely
 *      succeed once per job.
 */
export async function markJobPrintedNoRefundNeeded(jobId: string, reason: string, actor: MarkPrintedActor = {}): Promise<MarkPrintedResult> {
  const admin = supabaseAdmin();

  const { error: rpcError } = await admin.rpc("mark_job_printed_no_refund_needed", {
    p_job_id: jobId,
    p_reason: reason,
    p_actor_user_id: actor.userId ?? null,
    p_actor_role: actor.role ?? null,
    p_ip: actor.ip ?? null,
    p_user_agent: actor.userAgent ?? null,
  });
  if (rpcError) return { ok: false, reason: rpcError.message };

  const job = await getJob(jobId);
  if (!job) {
    // Should be unreachable (the RPC above just confirmed the row exists),
    // but the job genuinely is now marked printed either way — the revenue
    // bookkeeping just couldn't run, which is worth a loud log, not a
    // false "failed" back to the owner who correctly fixed the job status.
    console.error(`[CRITICAL] Job ${jobId} was marked printed but could not be re-fetched for revenue bookkeeping.`);
    return { ok: true };
  }

  await recordCompletedPrint(job.kioskId, {
    pagesPrinted: physicalSheetsForJob(job),
    amount: job.isFree || job.originalJobId !== undefined ? 0 : job.totalPrice,
    waivedAmount: job.isFree ? (job.waivedAmount ?? 0) : undefined,
    colorMode: job.settings.isColor,
    isFree: job.isFree,
    isReprint: job.originalJobId !== undefined,
    sheetKind: job.sheetKind,
    jobId: job.id,
  });

  return { ok: true };
}
