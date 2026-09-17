import { NextResponse } from "next/server";
import { deleteJob, listJobsEligibleForCleanup } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ROADMAP.md #4 — deletes uploaded PDFs (and their job rows) once they're no
 * longer needed, so Supabase Storage doesn't grow forever. Status-aware: see
 * listJobsEligibleForCleanup in lib/store.ts for exactly which jobs qualify
 * and why. Meant to be hit hourly by an external scheduler — see
 * CRON_SETUP.md — same CRON_SECRET-guarded pattern as
 * /api/cron/recheck-payments.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const eligibleJobs = await listJobsEligibleForCleanup();
    const results = await Promise.allSettled(eligibleJobs.map((job) => deleteJob(job)));
    const failed = results.filter((result) => result.status === "rejected").length;
    // A fulfilled-but-false result means deleteJob's atomic guard backed off
    // (another process changed the job's status first) — correctly not a failure.
    const deleted = results.filter((result) => result.status === "fulfilled" && result.value).length;
    return NextResponse.json({ checked: eligibleJobs.length, deleted, failed });
  } catch (error) {
    console.error("cleanup-jobs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not clean up old jobs." },
      { status: 500 }
    );
  }
}
