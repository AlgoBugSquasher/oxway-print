import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { MAX_PAGES_PER_STAFF_JOB, MAX_STAFF_DAILY_PAGES, MAX_UPLOAD_FILE_SIZE_BYTES, MAX_UPLOAD_PAGE_COUNT, getActiveProvider } from "@/lib/config";
import { getKioskUpdateState } from "@/lib/kiosk-stats";
import { computeBillableSheets, computeOrderPrice } from "@/lib/pricing";
import { extractSelectedPages, looksLikePdf } from "@/lib/print/pdf";
import { isWithinStaffPrintRateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import {
  createStaffPrintJob,
  deleteStorageObject,
  downloadJobPdf,
  getPricingConfig,
  uploadJobPdf,
  type PrintSettingsSnapshot,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface StaffPrintRequestBody {
  pdfStoragePath?: unknown;
  fileName?: unknown;
  selectedPages?: unknown;
  settings?: unknown;
  kioskId?: unknown;
  idempotencyKey?: unknown;
  forceCoverSheet?: unknown;
}

/**
 * Lets a signed-in owner/staff user print for free, through the SAME queue
 * and the SAME atomic claim path every paying customer's job already goes
 * through (print-agent/index.ts's claimNextPaidJob) — the only difference
 * from app/api/create-order is how the job becomes "paid": there's no
 * gateway order here at all, just createStaffPrintJob's single atomic
 * Postgres transaction (idempotency check, daily-cap check + increment,
 * ticket number, job row, all or nothing — see that function's own comment
 * in lib/store.ts and the staff-print migration).
 *
 * Deliberately mirrors create-order's own shape wherever the two tasks are
 * actually the same: the browser already uploaded the merged, print-ready
 * PDF directly to a temp Storage path (app/api/create-upload-url — same
 * route, same signed-URL flow, same multi-file client-side merge via
 * lib/pdf-merge.ts), and this route re-derives the real page count, sheets
 * and price from the ACTUAL downloaded bytes, never from anything the
 * client claims — exactly the same "never trust the client" discipline
 * create-order already has, just computing a waived amount instead of a
 * charged one.
 */
export async function POST(request: Request) {
  let tempUploadPath: string | null = null;

  try {
    // Server-side role check, reading from the verified Supabase session's
    // app_metadata — never from user_metadata (client-editable) or
    // anything the request body sends. Anonymous visitors and signed-in
    // customers (role "none" — no app_metadata.role at all) get 403. See
    // app/api/admin/refund/route.ts for the identical pattern this mirrors.
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const role = (user?.app_metadata as { role?: string } | undefined)?.role;
    if (!user || (role !== "owner" && role !== "staff")) {
      return jsonError("Not authorized.", 403);
    }

    if (!(await isWithinStaffPrintRateLimit(user.id))) {
      return jsonError("Too many staff prints from this account — please wait a minute and try again.", 429);
    }

    const body = (await request.json()) as StaffPrintRequestBody;
    const pdfStoragePath = typeof body.pdfStoragePath === "string" ? body.pdfStoragePath : "";
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const selectedPages = Array.isArray(body.selectedPages) ? (body.selectedPages as number[]) : [];
    const settings = (typeof body.settings === "object" && body.settings !== null ? body.settings : {}) as PrintSettingsSnapshot;
    const kioskId = typeof body.kioskId === "string" && body.kioskId ? body.kioskId : "oxway_01";
    // Optional — a client that sends none just gets no dedup against a
    // retry of its own request; createStaffPrintJob/the RPC handle a null
    // key fine (see lib/store.ts's own CreateStaffPrintJobInput comment).
    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : null;
    const forceCoverSheet = body.forceCoverSheet === true;

    if (!pdfStoragePath) return jsonError("Missing uploaded file reference.");
    tempUploadPath = pdfStoragePath;
    if (!fileName) return jsonError("Missing file name.");
    if (selectedPages.length === 0) return jsonError("Select at least one page.");

    // Mirrors create-order's own kiosk-update guard — a staff print is still
    // a print job at a physical printer, same reasoning applies.
    const updateState = await getKioskUpdateState(kioskId);
    if (updateState.isUpdating) {
      return jsonError("This kiosk is being updated right now — please try again in a minute.");
    }

    const originalBytes = await downloadJobPdf(pdfStoragePath);

    if (originalBytes.length > MAX_UPLOAD_FILE_SIZE_BYTES) {
      return jsonError(`This file is larger than the ${Math.round(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))} MB kiosk limit.`);
    }
    if (!looksLikePdf(originalBytes)) {
      return jsonError("The uploaded file isn't a valid PDF. Please upload it again.");
    }

    const contentHash = crypto.createHash("sha256").update(originalBytes).digest("hex");

    let extracted;
    try {
      extracted = await extractSelectedPages(originalBytes, selectedPages, settings.layout);
    } catch (parseError) {
      console.error("staff-print: uploaded file failed to parse as a PDF:", parseError);
      return jsonError("The uploaded file could not be read as a PDF. Please upload it again.");
    }

    if (extracted.pageCount > MAX_UPLOAD_PAGE_COUNT) {
      return jsonError(`This document has ${extracted.pageCount} pages, over the ${MAX_UPLOAD_PAGE_COUNT}-page kiosk limit.`);
    }
    // Stricter, staff-specific ceiling on top of the general kiosk one
    // above — a single request's own page count, safe to check directly
    // (no race risk, it's one job's own data, not a shared counter). The
    // DAILY total across however many jobs this user creates today is a
    // shared, concurrently-mutated counter instead, so THAT check has to
    // happen atomically inside createStaffPrintJob's own transaction, not
    // here — see this route's own comment further down.
    if (extracted.pageCount > MAX_PAGES_PER_STAFF_JOB) {
      return jsonError(`This document has ${extracted.pageCount} pages, over the ${MAX_PAGES_PER_STAFF_JOB}-page staff print limit.`);
    }

    // The price this job WOULD have cost a paying customer — computed from
    // the SAME server-side pricing rules create-order itself uses, never
    // from anything the client claims (there's no price field in this
    // route's own request body at all).
    const pricing = await getPricingConfig();
    const billableSheets = computeBillableSheets(extracted.pageCount, settings.pagesPerSheet, settings.copies);
    const waivedAmount = computeOrderPrice(billableSheets, settings.isColor, pricing);

    const jobId = crypto.randomUUID();
    const finalPdfStoragePath = await uploadJobPdf(jobId, extracted.bytes);

    // One atomic transaction: idempotency check, the daily-cap check +
    // increment (the genuinely racy part — two concurrent staff prints
    // from the same user must never both slip past MAX_STAFF_DAILY_PAGES),
    // ticket number assignment (the SAME next_ticket_number() sequence
    // every customer job uses, so two simultaneous jobs — staff or
    // customer — can never collide), and the job row itself, created
    // directly as 'paid'. See createStaffPrintJob's own doc comment.
    let job;
    try {
      job = await createStaffPrintJob({
        jobId,
        fileName,
        selectedPages: Array.from({ length: extracted.pageCount }, (_, index) => index + 1),
        settings,
        waivedAmount,
        contentHash,
        provider: getActiveProvider(),
        pdfStoragePath: finalPdfStoragePath,
        kioskId,
        idempotencyKey,
        createdByUserId: user.id,
        dailyCap: MAX_STAFF_DAILY_PAGES,
        forceCoverSheet,
      });
    } catch (createError) {
      // The daily-cap rejection (createStaffPrintJob's RPC raises a
      // Postgres exception for it) is the one failure here a staff member
      // should see as a clear, specific message rather than a generic
      // "could not create the job" — everything else falls through to the
      // outer catch below.
      const message = createError instanceof Error ? createError.message : "Could not create the print job.";
      if (/daily staff print cap/i.test(message)) return jsonError(message, 429);
      throw createError;
    }

    // Idempotent replay: createStaffPrintJob found an EARLIER job for this
    // same idempotencyKey and returned that one instead of creating a new
    // row — the PDF this request just uploaded to `${jobId}.pdf` is now an
    // orphan nothing references, so it's cleaned up immediately rather than
    // waiting on the cleanup cron's age-based sweep (that sweep only ever
    // looks at the "uploads/" temp prefix, never a job's own final path).
    if (job.id !== jobId) {
      await deleteStorageObject(finalPdfStoragePath);
    }

    return NextResponse.json({ jobId: job.id, ticketNumber: job.ticketNumber, waivedAmount: job.waivedAmount });
  } catch (error) {
    console.error("staff-print error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create the print job." },
      { status: 500 }
    );
  } finally {
    if (tempUploadPath) await deleteStorageObject(tempUploadPath);
  }
}
