import { NextResponse } from "next/server";
import { TEMP_UPLOAD_STALE_HOURS } from "@/lib/config";
import { deleteJob, deleteStorageObject, listJobsEligibleForCleanup, listStaleTempUploads } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ROADMAP.md #4 — deletes uploaded PDFs (and their job rows) once they're no
 * longer needed, so Supabase Storage doesn't grow forever. Status-aware: see
 * listJobsEligibleForCleanup in lib/store.ts for exactly which jobs qualify
 * and why. Meant to be hit hourly by an external scheduler — see
 * CRON_SETUP.md — same CRON_SECRET-guarded pattern as
 * /api/cron/recheck-payments.
 *
 * Also sweeps orphaned direct-to-storage uploads (lib/store.ts's
 * listStaleTempUploads) — a customer can request a signed upload URL, use
 * it, and then never call /api/create-order at all (closed the tab,
 * network dropped, etc.), leaving a raw file under the "uploads/" prefix
 * that no print_jobs row ever references. The job-row sweep above has
 * nothing to find there — it only ever looks at rows, and an orphan was
 * never a row — so this half is deliberately age-based against the
 * Storage object's own created_at instead.
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

    const staleUploads = await listStaleTempUploads(TEMP_UPLOAD_STALE_HOURS * 60 * 60 * 1000);
    await Promise.allSettled(staleUploads.map((path) => deleteStorageObject(path)));

    return NextResponse.json({ checked: eligibleJobs.length, deleted, failed, orphanedUploadsDeleted: staleUploads.length });
  } catch (error) {
    console.error("cleanup-jobs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not clean up old jobs." },
      { status: 500 }
    );
  }
}
