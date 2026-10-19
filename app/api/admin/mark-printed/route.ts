import { NextResponse } from "next/server";
import type { MarkPrintedResultItem } from "@/lib/admin/types";
import { markJobPrintedNoRefundNeeded } from "@/lib/mark-printed";
import { getClientIp } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same bulk-abuse cap as app/api/admin/refund — this page only ever lists a
// handful of failed/refund-pending jobs at once for a single kiosk.
const MAX_JOBS_PER_REQUEST = 100;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Owner-only, re-verified server-side (same reasoning as app/api/admin/
 * refund — the admin panel's own RLS/RPC layer has no bearing on this
 * route's own trust boundary). Single-job and bulk both send { jobIds }.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || role !== "owner") return jsonError("Not authorized.", 403);

    const body = await request.json().catch(() => null);
    const rawJobIds: unknown = body?.jobIds ?? (typeof body?.jobId === "string" ? [body.jobId] : null);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!Array.isArray(rawJobIds) || rawJobIds.length === 0 || !rawJobIds.every((id) => typeof id === "string" && id.length > 0)) {
      return jsonError("Missing jobIds.");
    }
    if (rawJobIds.length > MAX_JOBS_PER_REQUEST) {
      return jsonError(`Too many jobs selected at once (max ${MAX_JOBS_PER_REQUEST}).`);
    }
    if (!reason) return jsonError("A reason is required.");
    const jobIds = rawJobIds as string[];

    const actor = { userId: user.id, role, ip: getClientIp(request), userAgent: request.headers.get("user-agent") };
    const results: MarkPrintedResultItem[] = [];
    for (const jobId of jobIds) {
      const result = await markJobPrintedNoRefundNeeded(jobId, reason, actor);
      results.push(result.ok ? { jobId, ok: true } : { jobId, ok: false, error: result.reason });
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("admin/mark-printed error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not mark this job printed." },
      { status: 500 }
    );
  }
}
