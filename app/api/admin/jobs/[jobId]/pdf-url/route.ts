import { NextResponse } from "next/server";
import { createJobPdfDownloadUrl, getJob } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Matches the window the admin "Reprint pages" modal realistically needs: open it, wait for the file to download and thumbnails to render, decide. Short — never cached or reused beyond this one page load. */
const DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Owner-only (requirement: "Part B: Reprint pages (owner/admin only)") —
 * issues a short-lived signed URL the admin "Reprint pages" modal
 * downloads directly from Supabase Storage, so it can feed the EXISTING
 * job's own stored PDF through lib/hooks/useFileBasket.ts's thumbnail
 * pipeline (the same one every other page already uses), rather than
 * duplicating that client-side logic. A missing/removed file (the
 * TERMINAL_JOB_RETENTION_HOURS cleanup already deleted it — see
 * lib/store.ts's listJobsEligibleForCleanup) surfaces here as a clear
 * "file removed" message, not a generic failure.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || role !== "owner") return jsonError("Not authorized.", 403);

    const job = await getJob(jobId);
    if (!job) return jsonError("Job not found.", 404);

    let signedUrl: string;
    try {
      signedUrl = await createJobPdfDownloadUrl(job.pdfStoragePath, DOWNLOAD_URL_EXPIRY_SECONDS);
    } catch {
      return jsonError("This file was removed and can no longer be reprinted.", 410);
    }

    return NextResponse.json({ signedUrl, fileName: job.fileName, totalPages: job.selectedPages.length });
  } catch (error) {
    console.error("admin/jobs/[jobId]/pdf-url error:", error);
    return jsonError(error instanceof Error ? error.message : "Could not create a download link.", 500);
  }
}
