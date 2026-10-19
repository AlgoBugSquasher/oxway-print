import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { DUPLICATE_ORDER_WINDOW_SECONDS, getActiveProvider, MAX_UPLOAD_FILE_SIZE_BYTES, MAX_UPLOAD_PAGE_COUNT } from "@/lib/config";
import { getKioskColorModes, getKioskPrintBlockedState, getKioskUpdateState, getKioskWhatsappAvailability, isKioskCurrentlyOnline } from "@/lib/kiosk-stats";
import { createOrder, type CreateOrderOutput } from "@/lib/payment";
import { computeBillableSheets, computeOrderPrice } from "@/lib/pricing";
import { extractSelectedPages, looksLikePdf } from "@/lib/print/pdf";
import { getClientIp, isWithinCreateOrderRateLimit } from "@/lib/rate-limit";
import {
  assignTicketNumber,
  createJob,
  deleteStorageObject,
  downloadJobPdf,
  findRecentDuplicateJob,
  getPricingConfig,
  updateJob,
  uploadJobPdf,
  type PrintJobRecord,
  type PrintSettingsSnapshot,
} from "@/lib/store";

// Cents-of-a-rupee tolerance for float rounding — not a real "the price can be slightly off" allowance.
const PRICE_EPSILON = 0.01;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// WhatsApp opt-in re-enables ROADMAP.md §1's phone collection — same
// pattern the (re-enabled) client-side check in PdfPageSelector.tsx uses,
// checked again here since the client check alone isn't trustworthy.
const PHONE_PATTERN = /^[6-9]\d{9}$/;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface CreateOrderRequestBody {
  pdfStoragePath?: unknown;
  fileName?: unknown;
  selectedPages?: unknown;
  settings?: unknown;
  totalPrice?: unknown;
  notifyOptIn?: unknown;
  phone?: unknown;
  kioskId?: unknown;
  pickupMode?: unknown;
}

/** Reconstructs the same response shape /api/create-order normally returns, from an existing job — used for the duplicate-order short-circuit (ROADMAP.md #13). */
function buildOrderResponse(job: PrintJobRecord): { jobId: string } & CreateOrderOutput {
  if (job.provider === "cashfree") {
    return {
      jobId: job.id,
      provider: "cashfree",
      providerOrderId: job.providerOrderId,
      paymentSessionId: job.providerMeta?.paymentSessionId ?? "",
    };
  }
  return {
    jobId: job.id,
    provider: "razorpay",
    providerOrderId: job.providerOrderId,
    keyId: job.providerMeta?.keyId ?? "",
    amount: Number(job.providerMeta?.amount ?? 0),
  };
}

/**
 * Downloads the just-uploaded raw PDF from its temp storage path, uploads
 * the final print-ready PDF to Supabase Storage, and writes a job row, then
 * creates an order with the active payment gateway. The website and the
 * Pi's print agent only ever talk to each other through that Supabase row.
 *
 * The file itself never passes through this route's own request body —
 * see app/api/create-upload-url/route.ts, which the client calls first to
 * upload directly to Storage. This route only ever receives JSON metadata
 * and the resulting storage path, regardless of how large the file is, so
 * it can never hit Vercel's serverless function request-body limit the way
 * the old multipart-upload version of this route did.
 */
export async function POST(request: Request) {
  // Tracks the temp upload across every early-return below so it's always
  // cleaned up exactly once, however this request ends — set the moment
  // it's known, read in the `finally` block at the very end.
  let tempUploadPath: string | null = null;

  try {
    const clientIp = getClientIp(request);
    if (!(await isWithinCreateOrderRateLimit(clientIp))) {
      return jsonError("Too many print orders from this connection — please wait a minute and try again.", 429);
    }

    const body = (await request.json()) as CreateOrderRequestBody;
    const pdfStoragePath = typeof body.pdfStoragePath === "string" ? body.pdfStoragePath : "";
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const selectedPages = Array.isArray(body.selectedPages) ? (body.selectedPages as number[]) : [];
    const settings = (typeof body.settings === "object" && body.settings !== null ? body.settings : {}) as PrintSettingsSnapshot;
    const totalPrice = typeof body.totalPrice === "number" ? body.totalPrice : 0;
    // Which physical kiosk this order is for — the customer's QR encodes it
    // as a URL query param, the frontend forwards it here. Defaults to the
    // single kiosk this project started with, so today's QR (no param)
    // keeps working unchanged. Read before the WhatsApp fields below since
    // the per-kiosk allow_whatsapp check needs it.
    const kioskId = typeof body.kioskId === "string" && body.kioskId ? body.kioskId : "oxway_01";

    if (!pdfStoragePath) return jsonError("Missing uploaded file reference.");
    tempUploadPath = pdfStoragePath;
    if (!fileName) return jsonError("Missing file name.");
    if (selectedPages.length === 0) return jsonError("Select at least one page.");
    if (!totalPrice || totalPrice <= 0) return jsonError("Invalid order total.");

    // WhatsApp opt-in (re-enabled ROADMAP.md §1) — a phone number is only
    // ever stored when the customer actually opted in; the client is never
    // trusted on this (same reasoning as totalPrice above), so both fields
    // are re-derived from scratch here rather than just re-validated. When
    // the owner has WhatsApp turned off for this kiosk, any opt-in/phone
    // the client sends is silently ignored (not an error — there's no
    // checkbox to even tamper with in that state, see
    // components/PdfPageSelector.tsx) rather than rejecting the order.
    const whatsappAvailability = await getKioskWhatsappAvailability(kioskId);
    const notifyOptIn = whatsappAvailability.allowWhatsapp && body.notifyOptIn === true;
    const rawPhone = notifyOptIn && typeof body.phone === "string" ? body.phone.trim() : "";
    if (notifyOptIn && !PHONE_PATTERN.test(rawPhone)) {
      return jsonError("Enter a valid 10-digit phone number, or untick WhatsApp updates.");
    }
    const phone = rawPhone;
    const includeBannerPage = true;
    const pickupMode: "here" | "later" = body.pickupMode === "later" ? "later" : "here";

    // Admin can disable color or B&W per kiosk (owner/staff only, see
    // update_kiosk_counters in supabase/schema.sql) — the customer page
    // mirrors this by greying out the disabled mode, but that's a UI nicety
    // only; a tampered or stale request must be rejected here regardless.
    const colorModes = await getKioskColorModes(kioskId);
    if (settings.isColor && !colorModes.allowColor) {
      return jsonError("Color printing is currently unavailable at this kiosk.");
    }
    if (!settings.isColor && !colorModes.allowBw) {
      return jsonError("B&W printing is currently unavailable at this kiosk.");
    }

    // A remote "Update kiosk" command is pending/running for this kiosk —
    // the customer page already blocks starting a new order in this state
    // (same /api/kiosk-status poll this re-checks), but that's a UI mirror
    // only, same reasoning as the color-mode check above.
    const updateState = await getKioskUpdateState(kioskId);
    if (updateState.isUpdating) {
      return jsonError("This kiosk is being updated right now — please try again in a minute.");
    }

    // Requirement: "do not let new customers pay while the machine cannot
    // print" — the customer page already blocks starting a new order
    // while this is true (same /api/kiosk-status poll this re-checks),
    // but that's a UI mirror only, same reasoning as every other kiosk-
    // availability check above. Set only by the print agent itself the
    // instant it detects a recoverable printer problem (lib/print/cups.ts),
    // and cleared the same way once it's ready again — no admin action
    // needed either way.
    const printBlockedState = await getKioskPrintBlockedState(kioskId);
    if (printBlockedState.printBlocked) {
      return jsonError("This kiosk can't print right now (it needs attention) — please try again shortly.");
    }

    // Goal: "nobody can pay while the kiosk is offline." Checked here, not
    // just on the customer page (which already disables Pay and polls the
    // same /api/kiosk-status signal) — a tampered or stale request must be
    // refused server-side regardless. Creates NOTHING (no job, no gateway
    // order) rather than creating a job that would just sit paid and
    // unclaimed — see isKioskCurrentlyOnline (lib/kiosk-stats.ts) for the
    // one shared definition of "offline" this reuses.
    if (!(await isKioskCurrentlyOnline(kioskId))) {
      console.log(`[create-order] Refused — kiosk "${kioskId}" is offline.`);
      return jsonError("This kiosk is offline right now, so payment is turned off. Please try again in a few minutes.");
    }

    const originalBytes = await downloadJobPdf(pdfStoragePath);

    // The client already declared a size when requesting the upload URL
    // (app/api/create-upload-url), but that was only ever a pre-check —
    // this is the actual uploaded content, so it's the one that counts.
    if (originalBytes.length > MAX_UPLOAD_FILE_SIZE_BYTES) {
      return jsonError(`This file is larger than the ${Math.round(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))} MB kiosk limit.`);
    }
    // Cheap magic-header check before spending a full parse on something
    // that was never a PDF at all (see looksLikePdf's own docstring) —
    // genuinely malformed uploads, a failed/corrupted direct-to-storage
    // transfer, or (ROADMAP.md #19-style) anything else that isn't what it
    // claims to be.
    if (!looksLikePdf(originalBytes)) {
      return jsonError("The uploaded file isn't a valid PDF. Please upload it again.");
    }

    const contentHash = crypto.createHash("sha256").update(originalBytes).digest("hex");

    // Extraction has to happen before pricing now — the true billable page
    // count is what ends up in the output PDF, not the client's raw
    // selectedPages.length (out-of-range page numbers get silently dropped
    // here, which would otherwise let the price basis and the actual
    // printed page count quietly diverge). See ExtractedPdf's docstring.
    // Also doubles as this upload's real validity check — the magic-byte
    // check above only confirms the file *starts* like a PDF; a pdf-lib
    // parse failure here means it isn't a genuinely readable one, and
    // "readable page count" (this function's only way to succeed at all)
    // is exactly the bar requested.
    let extracted;
    try {
      extracted = await extractSelectedPages(originalBytes, selectedPages, settings.layout);
    } catch (parseError) {
      console.error("create-order: uploaded file failed to parse as a PDF:", parseError);
      return jsonError("The uploaded file could not be read as a PDF. Please upload it again.");
    }

    // Multi-file basket uploads (components/PdfPageSelector.tsx) are merged
    // into one PDF client-side before reaching here — lib/pdf-merge.ts — so
    // this one check is what actually enforces the combined basket's own
    // page-count limit (lib/hooks/useFileBasket.ts's MAX_TOTAL_PAGES_PER_BASKET)
    // server-side, against the real page count, not whatever the client
    // claimed.
    if (extracted.pageCount > MAX_UPLOAD_PAGE_COUNT) {
      return jsonError(`This document has ${extracted.pageCount} pages, over the ${MAX_UPLOAD_PAGE_COUNT}-page kiosk limit.`);
    }

    // Server-side price recalculation (ROADMAP.md #13's flagged gap) — the
    // client-submitted totalPrice was previously trusted with only a >0
    // check, meaning a tampered request could pay less than it should.
    // Recompute the true price from current admin-set pricing and the real
    // page count, and reject outright on any mismatch rather than silently
    // preferring either value.
    const pricing = await getPricingConfig();
    const billableSheets = computeBillableSheets(extracted.pageCount, settings.pagesPerSheet, settings.copies);
    const expectedPrice = computeOrderPrice(billableSheets, settings.isColor, pricing);
    if (Math.abs(expectedPrice - totalPrice) > PRICE_EPSILON) {
      return jsonError("Price mismatch — please refresh and try again.");
    }

    // Idempotency for a double-clicked Pay button or a flaky-connection
    // retry: an identical (file + settings + price) submission within the
    // last minute gets the same order back instead of a second paid order
    // for one upload. See findRecentDuplicateJob for what "identical" means
    // and the known best-effort limits of this check.
    const duplicate = await findRecentDuplicateJob({
      contentHash,
      totalPrice: expectedPrice,
      settings,
      windowSeconds: DUPLICATE_ORDER_WINDOW_SECONDS,
    });
    if (duplicate) return NextResponse.json(buildOrderResponse(duplicate));

    const jobId = crypto.randomUUID();
    const finalPdfStoragePath = await uploadJobPdf(jobId, extracted.bytes);

    const now = new Date().toISOString();
    const provider = getActiveProvider();

    // Ticket code (ROADMAP.md §21) — assigned here, at creation, not tied to
    // payment confirmation timing, per that section's own reasoning. Atomic
    // per kiosk/day; see next_ticket_number() in supabase/schema.sql.
    const { ticketNumber, ticketDate } = await assignTicketNumber(kioskId);

    // Create the job first so it exists even if gateway order creation fails,
    // then attach the gateway's order id. totalPrice here is the
    // server-computed expectedPrice, never the client's submitted value —
    // even though they've now been checked to match, the persisted/charged
    // amount always comes from the server's own calculation.
    const job: PrintJobRecord = {
      id: jobId,
      status: "pending_payment",
      fileName,
      selectedPages,
      settings,
      totalPrice: expectedPrice,
      phoneNumber: phone,
      notifyOptIn,
      includeBannerPage,
      contentHash,
      provider,
      providerOrderId: "",
      pdfStoragePath: finalPdfStoragePath,
      kioskId,
      ticketNumber,
      ticketDate,
      pickupMode,
      forceCoverSheet: false,
      createdAt: now,
      updatedAt: now,
    };
    await createJob(job);

    const order = await createOrder({ jobId, amountRupees: expectedPrice, fileName, phone });
    await updateJob(jobId, {
      providerOrderId: order.providerOrderId,
      providerMeta: order.provider === "cashfree"
        ? { paymentSessionId: order.paymentSessionId }
        : { keyId: order.keyId, amount: String(order.amount) },
    });

    return NextResponse.json({ jobId, ...order });
  } catch (error) {
    console.error("create-order error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create the payment order." },
      { status: 500 }
    );
  } finally {
    // Whatever happened above — success, a validation rejection, an
    // invalid-PDF rejection, or an unexpected throw — the temp upload this
    // request named is never needed again afterward: either it's now
    // copied into a real job's own final path (uploadJobPdf above), or the
    // order was never created from it at all. Best-effort (see
    // deleteStorageObject); a leaked temp object is still caught later by
    // the cleanup cron's orphan sweep (listStaleTempUploads), so a failure
    // here is never the only safety net.
    if (tempUploadPath) await deleteStorageObject(tempUploadPath);
  }
}
