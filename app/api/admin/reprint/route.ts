import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { extractSelectedPages } from "@/lib/print/pdf";
import { formatReprintNote } from "@/lib/print/reprint-note";
import { createReprintJob, deleteStorageObject, downloadJobPdf, getJob, uploadJobPdf, type PrintSettingsSnapshot } from "@/lib/store";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Copies is the one setting this feature lets an owner pick directly (default 1, per requirement #3) — bounded the same generous-but-sane way the customer/staff print settings already are, just inlined here since this route has no shared "print settings" validator of its own. */
const MAX_REPRINT_COPIES = 20;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface ReprintRequestBody {
  originalJobId?: unknown;
  selectedPages?: unknown;
  copies?: unknown;
  forceCoverSheet?: unknown;
}

/**
 * Owner-only (requirement: "Part B: Reprint pages (owner/admin only)" —
 * re-verified here server-side from the actual session, never trusted
 * from the client, same pattern app/api/admin/refund already uses).
 * Creates a NEW, free job containing only the requested pages from an
 * EXISTING job's stored PDF — never modifies the original job's own row
 * beyond adding its "reprinted pages X to Y" note (requirement #6), and
 * never touches the original CONTENT pages themselves (extractSelectedPages
 * only extracts/rotates, the same function every normal order already
 * goes through — no stamps, no shrinking, no added text).
 *
 * Validation order matches requirement #5's own list:
 *   1. owner-only (403 otherwise — covers the "staff blocked" test case)
 *   2. the original job's CURRENT refund_status — already refunded blocks
 *      outright (re-checked again, atomically, inside create_reprint_job
 *      itself — this upfront check is just a faster-failing UX nicety)
 *   3. the stored file must still exist (downloadJobPdf failing here IS
 *      that check — nothing else in this route needs to separately ask
 *      "does the file exist")
 *   4. every requested page validated against the REAL page count
 *      (job.selectedPages.length — not the client's claim, not a fresh
 *      PDF parse either: the stored file's own page count has always
 *      exactly equalled this since the job was first created, same as
 *      every other job in this app)
 */
export async function POST(request: Request) {
  let uploadedPath: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || role !== "owner") return jsonError("Not authorized.", 403);

    const body = (await request.json()) as ReprintRequestBody;
    const originalJobId = typeof body.originalJobId === "string" ? body.originalJobId : "";
    const selectedPages = Array.isArray(body.selectedPages) ? (body.selectedPages as unknown[]) : [];
    const copies = typeof body.copies === "number" && Number.isInteger(body.copies) ? body.copies : 1;
    const forceCoverSheet = body.forceCoverSheet === true;

    if (!originalJobId) return jsonError("Missing originalJobId.");
    if (selectedPages.length === 0) return jsonError("Select at least one page to reprint.");
    if (!selectedPages.every((page) => typeof page === "number" && Number.isInteger(page) && page >= 1)) {
      return jsonError("Selected pages must be positive whole numbers.");
    }
    if (copies < 1 || copies > MAX_REPRINT_COPIES) return jsonError(`Copies must be between 1 and ${MAX_REPRINT_COPIES}.`);

    const original = await getJob(originalJobId);
    if (!original) return jsonError("Original job not found.", 404);

    if (original.refundStatus === "refunded") {
      return jsonError("This job has already been refunded — a free reprint would mean the customer keeps the refund AND gets a free reprint.");
    }

    // The real page count — see this route's own docstring for why this,
    // not a fresh PDF parse, is the authoritative number.
    const realPageCount = original.selectedPages.length;
    const outOfRange = (selectedPages as number[]).find((page) => page > realPageCount);
    if (outOfRange !== undefined) {
      return jsonError(`Page ${outOfRange} doesn't exist — this job only has ${realPageCount} page${realPageCount === 1 ? "" : "s"}.`);
    }

    let originalBytes;
    try {
      originalBytes = await downloadJobPdf(original.pdfStoragePath);
    } catch {
      return jsonError("The file was removed and can no longer be reprinted.", 410);
    }

    const extracted = await extractSelectedPages(originalBytes, selectedPages as number[], original.settings.layout);

    const newJobId = crypto.randomUUID();
    uploadedPath = await uploadJobPdf(newJobId, extracted.bytes);

    const settings: PrintSettingsSnapshot = { ...original.settings, copies };
    const reprintNote = formatReprintNote(selectedPages as number[], new Date());

    let job;
    try {
      job = await createReprintJob({
        jobId: newJobId,
        originalJobId,
        selectedPages: Array.from({ length: extracted.pageCount }, (_, index) => index + 1),
        settings,
        includeBannerPage: false,
        contentHash: original.contentHash,
        pdfStoragePath: uploadedPath,
        createdByUserId: user.id,
        reprintNote,
        forceCoverSheet,
      });
    } catch (createError) {
      // The job row was never created (or the RPC's own atomic re-check —
      // e.g. "already refunded" — rejected it) — the PDF just uploaded to
      // `${newJobId}.pdf` is now an orphan nothing references, cleaned up
      // immediately rather than waiting on the cleanup cron's age-based
      // sweep (same reasoning app/api/staff-print's own idempotent-replay
      // cleanup gives).
      await deleteStorageObject(uploadedPath);
      uploadedPath = null;
      throw createError;
    }

    return NextResponse.json({ jobId: job.id, ticketNumber: job.ticketNumber });
  } catch (error) {
    console.error("admin/reprint error:", error);
    return jsonError(error instanceof Error ? error.message : "Could not create the reprint.", 500);
  }
}
