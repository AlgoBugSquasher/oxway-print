import { NextResponse } from "next/server";
import { attemptRefund } from "@/lib/refund";
import { getJob } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same statuses the admin UI gates the refund button on (app/admin/(dashboard)/jobs/page.tsx).
const REFUNDABLE_STATUSES = ["print_failed", "payment_failed"];

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * ROADMAP.md #10 — real money movement, so this is a plain Next.js route
 * handler, not a Postgres RPC: RAZORPAY_KEY_SECRET must never reach
 * RLS-gated browser code. Independently verifies the caller is a signed-in
 * owner (the admin panel's RLS/RPC layer has no bearing on this route at
 * all — it's a separate trust boundary that has to redo its own check).
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || role !== "owner") return jsonError("Not authorized.", 403);

    const { jobId } = await request.json();
    if (!jobId || typeof jobId !== "string") return jsonError("Missing jobId.");

    const job = await getJob(jobId);
    if (!job) return jsonError("Job not found.", 404);
    if (!REFUNDABLE_STATUSES.includes(job.status)) return jsonError(`Cannot refund a job with status "${job.status}".`);

    // The actual money-movement (and its own already-refunded /
    // no-captured-payment guards) is shared with print-agent/index.ts's
    // automatic refund-on-print-failure (ROADMAP.md §10) — see lib/refund.ts.
    const result = await attemptRefund(job);
    if (!result.ok) {
      return jsonError(
        result.reason === "already_refunded"
          ? "This job was already refunded."
          : "No captured payment reference on this job — nothing to refund."
      );
    }

    return NextResponse.json({ refundId: result.refundId });
  } catch (error) {
    console.error("admin/refund error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not process the refund." },
      { status: 500 }
    );
  }
}
