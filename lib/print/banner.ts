import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { shortRequestId } from "../request-id";
import type { PrintJobRecord } from "../store";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

function centeredX(font: PDFFont, text: string, size: number, pageWidth: number): number {
  return (pageWidth - font.widthOfTextAtSize(text, size)) / 2;
}

/**
 * Builds a single pickup-ID cover page and prepends it to the print-ready
 * PDF — only called when the customer opted in (job.includeBannerPage, see
 * ROADMAP.md #5). Returns one PDF (banner as page 1, then the original
 * content), submitted to CUPS as a single job with the existing `-n copies`
 * flow in lib/print/cups.ts.
 *
 * CUPS duplicates the whole submitted PDF per copy, so the banner correctly
 * lands on every physical copy, not just the first — that's the intended
 * behavior (each copy is its own stack that needs its own identifier), not
 * a bug. print-agent/index.ts's sheet-count math accounts for this: the +1
 * is applied per copy, not once flat — see the comment there.
 */
export async function prependBannerPage(contentPdfBytes: Uint8Array, job: PrintJobRecord): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const regular = await output.embedFont(StandardFonts.Helvetica);

  // Loaded (and copied) before the banner page itself so the banner can
  // match the content's actual orientation — copyPages doesn't insert
  // these into output's page tree yet, that only happens at the
  // output.addPage() calls below, so doing this first doesn't change the
  // final page order (banner still ends up as page 1).
  const content = await PDFDocument.load(contentPdfBytes);
  const contentPages = await output.copyPages(content, content.getPageIndices());

  // A landscape print job with the banner enabled would otherwise mix a
  // portrait cover sheet in with landscape content pages inside the same
  // CUPS job — a mixed-page-size job that can confuse a printer's
  // fit-to-page handling, and at best just looks wrong: a portrait sheet
  // sitting sideways-relative-to-everything-else in an otherwise-landscape
  // stack. Match extractSelectedPages' own notion of orientation (width vs
  // height of the already-processed content) rather than re-deriving it.
  const [firstContentPage] = contentPages;
  const isContentLandscape = firstContentPage.getWidth() > firstContentPage.getHeight();
  const bannerWidth = isContentLandscape ? A4_HEIGHT : A4_WIDTH;
  const bannerHeight = isContentLandscape ? A4_WIDTH : A4_HEIGHT;

  const banner = output.addPage([bannerWidth, bannerHeight]);
  // ROADMAP.md §21's ticket code is the number shown to the customer on
  // their phone and on the kiosk screen — the banner has to print the SAME
  // code, big, or the whole point of a pickup-ID page (matching what's on
  // paper to what the customer is looking at) breaks. Falls back to the
  // Request ID only in the defensive case a job somehow reached printing
  // without one assigned, which shouldn't happen since §21 assigns it at
  // creation — never expected in practice, just not a hard crash if it did.
  const pickupCode = job.ticketNumber != null ? `#${String(job.ticketNumber).padStart(3, "0")}` : shortRequestId(job.id);
  const requestId = shortRequestId(job.id);
  const timestamp = new Date(job.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  // Phone number collection (ROADMAP.md §1) is disabled in this build, so
  // job.phoneNumber is always "" — skip the phone segment instead of
  // printing a blank "Phone ***" on every banner. Picks the phone back up
  // automatically, with no change needed here, if §1 is ever re-enabled.
  const last4 = job.phoneNumber.slice(-4);

  // Centered vertically on the page — moving this text up or down can't
  // actually change which physical edge faces the printer's mechanism
  // (that's fixed by the paper path, not by where content sits on the
  // page), so there's no positioning that fixes accessibility on a given
  // printer; middle is the neutral default that isn't wrong for any of them.
  const label = "PICKUP ID";
  banner.drawText(label, {
    x: centeredX(bold, label, 24, bannerWidth),
    y: bannerHeight - 220,
    size: 24,
    font: bold,
    color: rgb(0.29, 0.33, 0.41),
  });
  banner.drawText(pickupCode, {
    x: centeredX(bold, pickupCode, 90, bannerWidth),
    y: bannerHeight - 340,
    size: 90,
    font: bold,
    color: rgb(0.15, 0.39, 0.92),
  });
  const detailLine = last4 ? `Phone ***${last4}  ·  ${timestamp}` : timestamp;
  banner.drawText(detailLine, {
    x: centeredX(regular, detailLine, 13, bannerWidth),
    y: bannerHeight - 400,
    size: 13,
    font: regular,
    color: rgb(0.45, 0.5, 0.57),
  });
  // Kept small — useful for staff tracing a specific printout back to its
  // exact job (e.g. in Supabase or a support conversation) without being
  // confused for the pickup code itself.
  const requestIdLine = `Request ID: ${requestId}`;
  banner.drawText(requestIdLine, {
    x: centeredX(regular, requestIdLine, 11, bannerWidth),
    y: bannerHeight - 420,
    size: 11,
    font: regular,
    color: rgb(0.65, 0.68, 0.72),
  });
  const brand = "OXWAY";
  banner.drawText(brand, {
    x: centeredX(bold, brand, 16, bannerWidth),
    y: 60,
    size: 16,
    font: bold,
    color: rgb(0.15, 0.39, 0.92),
  });

  contentPages.forEach((page) => output.addPage(page));

  return output.save();
}
