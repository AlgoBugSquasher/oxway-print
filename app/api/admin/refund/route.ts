import { NextResponse } from "next/server";
import type { RefundRouteResultItem } from "@/lib/admin/types";
import { getClientIp } from "@/lib/rate-limit";
import { attemptRefund, recordBulkRefundAction } from "@/lib/refund";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A malformed or abusive request submitting a huge jobIds array shouldn't
// hammer the payment gateway sequentially for minutes — generous enough
// for any real "select all pending" click to ever need (the Refunds admin
// page itself only ever lists pending refunds, which is never a high-volume
// state for a single kiosk business).
const MAX_JOBS_PER_REQUEST = 100;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Real money movement, so this is a plain Next.js route handler, not a
 * Postgres RPC: RAZORPAY_KEY_SECRET must never reach RLS-gated browser
 * code. Independently verifies the caller is a signed-in owner (the admin
 * panel's RLS/RPC layer has no bearing on this route at all — it's a
 * separate trust boundary that has to redo its own check) — this is also
 * the real enforcement of "staff cannot see/trigger this," not just which
 * admin page links here.
 *
 * Single-job and bulk use the exact same body shape ({ jobIds: [...] }) —
 * a single "Refund" click just sends an array of one. Each job is
 * refunded one at a time, in order, never in parallel: lib/refund.ts's
 * attemptRefund already makes a SINGLE job's double-click/two-tabs case
 * safe via its own atomic DB claim, so sequencing here is just to avoid
 * hammering the payment gateway with concurrent requests and to keep each
 * job's own success/failure fully independent of every other one in the
 * batch (requirement: "bulk with one failure" must never block the rest).
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || role !== "owner") return jsonError("Not authorized.", 403);

    const body = await request.json().catch(() => null);
    const rawJobIds: unknown = body?.jobIds ?? (typeof body?.jobId === "string" ? [body.jobId] : null);
    if (!Array.isArray(rawJobIds) || rawJobIds.length === 0 || !rawJobIds.every((id) => typeof id === "string" && id.length > 0)) {
      return jsonError("Missing jobIds.");
    }
    if (rawJobIds.length > MAX_JOBS_PER_REQUEST) {
      return jsonError(`Too many jobs selected at once (max ${MAX_JOBS_PER_REQUEST}).`);
    }
    const jobIds = rawJobIds as string[];

    const actor = { userId: user.id, role, ip: getClientIp(request), userAgent: request.headers.get("user-agent") };
    const results: RefundRouteResultItem[] = [];
    let totalRefunded = 0;

    for (const jobId of jobIds) {
      const result = await attemptRefund(jobId, actor);
      if (result.ok) {
        totalRefunded += result.amountRupees;
        results.push({ jobId, ok: true, refundId: result.refundId });
      } else {
        results.push({ jobId, ok: false, error: result.reason });
      }
    }

    // One extra summary entry for a genuine bulk submission — a single-job
    // request's own per-job audit entry (written inside complete_refund/
    // fail_refund) already says everything there is to say about it.
    if (jobIds.length > 1) {
      const succeeded = results.filter((r) => r.ok).length;
      await recordBulkRefundAction({
        jobIds,
        totalRupees: totalRefunded,
        succeeded,
        failed: results.length - succeeded,
        actor,
      });
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("admin/refund error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not process the refund." },
      { status: 500 }
    );
  }
}
