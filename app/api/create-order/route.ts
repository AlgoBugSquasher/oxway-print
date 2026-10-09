import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { DUPLICATE_ORDER_WINDOW_SECONDS, getActiveProvider } from "@/lib/config";
import { getKioskColorModes, getKioskUpdateState, getKioskWhatsappAvailability } from "@/lib/kiosk-stats";
import { createOrder, type CreateOrderOutput } from "@/lib/payment";
import { extractSelectedPages } from "@/lib/print/pdf";
import { getClientIp, isWithinCreateOrderRateLimit } from "@/lib/rate-limit";
import {
  assignTicketNumber,
  createJob,
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

// Same limit as PdfPageSelector.tsx's client-side check (ROADMAP.md #19) —
// the client check alone isn't trustworthy, and without a server-side
// bound, an oversized file's PDF processing below can push past the
// platform's memory/time limit and crash the function outright, before its
// own try/catch ever gets to run — the exact failure mode #19 describes.
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
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
 * Uploads the final print-ready PDF to Supabase Storage and writes a job row,
 * then creates an order with the active payment gateway. The website and the
 * Pi's print agent only ever talk to each other through that Supabase row.
 */
export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    if (!(await isWithinCreateOrderRateLimit(clientIp))) {
      return jsonError("Too many print orders from this connection — please wait a minute and try again.", 429);
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const fileName = String(formData.get("fileName") || "");
    const selectedPages = JSON.parse(String(formData.get("selectedPages") || "[]")) as number[];
    const settings = JSON.parse(String(formData.get("settings") || "{}")) as PrintSettingsSnapshot;
    const totalPrice = Number(formData.get("totalPrice") || 0);
    // Which physical kiosk this order is for — the customer's QR encodes it
    // as a URL query param, the frontend forwards it here. Defaults to the
    // single kiosk this project started with, so today's QR (no param)
    // keeps working unchanged. Read before the WhatsApp fields below since
    // the per-kiosk allow_whatsapp check needs it.
    const kioskId = String(formData.get("kioskId") || "oxway_01");

    // WhatsApp opt-in (re-enabled ROADMAP.md §1) — a phone number is only
    // ever stored when the customer actually opted in; the client is never
    // trusted on this (same reasoning as totalPrice below), so both fields
    // are re-derived from scratch here rather than just re-validated. When
    // the owner has WhatsApp turned off for this kiosk, any opt-in/phone
    // the client sends is silently ignored (not an error — there's no
    // checkbox to even tamper with in that state, see
    // components/PdfPageSelector.tsx) rather than rejecting the order.
    const whatsappAvailability = await getKioskWhatsappAvailability(kioskId);
    const notifyOptIn = whatsappAvailability.allowWhatsapp && String(formData.get("notifyOptIn") || "") === "true";
    const rawPhone = notifyOptIn ? String(formData.get("phone") || "").trim() : "";
    if (notifyOptIn && !PHONE_PATTERN.test(rawPhone)) {
      return jsonError("Enter a valid 10-digit phone number, or untick WhatsApp updates.");
    }
    const phone = rawPhone;
    // The pickup-ID banner is mandatory on every job — never read from the
    // client (there's no checkbox for it anymore in PdfPageSelector.tsx,
    // but even if a request forged this field, it's ignored).
    const includeBannerPage = true;

    if (!(file instanceof File)) return jsonError("Missing print-ready PDF.");
    if (file.size > MAX_FILE_SIZE) return jsonError("This file is larger than the 25 MB kiosk limit.");
    if (!fileName) return jsonError("Missing file name.");
    if (!Array.isArray(selectedPages) || selectedPages.length === 0) return jsonError("Select at least one page.");
    if (!totalPrice || totalPrice <= 0) return jsonError("Invalid order total.");

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

    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const contentHash = crypto.createHash("sha256").update(originalBytes).digest("hex");

    // Extraction has to happen before pricing now — the true billable page
    // count is what ends up in the output PDF, not the client's raw
    // selectedPages.length (out-of-range page numbers get silently dropped
    // here, which would otherwise let the price basis and the actual
    // printed page count quietly diverge). See ExtractedPdf's docstring.
    const extracted = await extractSelectedPages(originalBytes, selectedPages, settings.layout);

    // Server-side price recalculation (ROADMAP.md #13's flagged gap) — the
    // client-submitted totalPrice was previously trusted with only a >0
    // check, meaning a tampered request could pay less than it should.
    // Recompute the true price from current admin-set pricing and the real
    // page count, and reject outright on any mismatch rather than silently
    // preferring either value.
    const pricing = await getPricingConfig();
    const billableSheets = Math.ceil(extracted.pageCount / settings.pagesPerSheet) * settings.copies;
    const expectedPrice = billableSheets * (settings.isColor ? pricing.priceColor : pricing.priceBw);
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
    const pdfStoragePath = await uploadJobPdf(jobId, extracted.bytes);

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
      pdfStoragePath,
      kioskId,
      ticketNumber,
      ticketDate,
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
  }
}
