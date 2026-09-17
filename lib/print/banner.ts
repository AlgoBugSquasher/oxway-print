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

  const banner = output.addPage([A4_WIDTH, A4_HEIGHT]);
  const requestId = shortRequestId(job.id);
  const timestamp = new Date(job.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  // Phone number collection (ROADMAP.md §1) is disabled in this build, so
  // job.phoneNumber is always "" — skip the phone segment instead of
  // printing a blank "Phone ***" on every banner. Picks the phone back up
  // automatically, with no change needed here, if §1 is ever re-enabled.
  const last4 = job.phoneNumber.slice(-4);

  const label = "PICKUP ID";
  banner.drawText(label, {
    x: centeredX(bold, label, 24, A4_WIDTH),
    y: A4_HEIGHT - 220,
    size: 24,
    font: bold,
    color: rgb(0.29, 0.33, 0.41),
  });
  banner.drawText(requestId, {
    x: centeredX(bold, requestId, 90, A4_WIDTH),
    y: A4_HEIGHT - 340,
    size: 90,
    font: bold,
    color: rgb(0.15, 0.39, 0.92),
  });
  const detailLine = last4 ? `Phone ***${last4}  ·  ${timestamp}` : timestamp;
  banner.drawText(detailLine, {
    x: centeredX(regular, detailLine, 13, A4_WIDTH),
    y: A4_HEIGHT - 400,
    size: 13,
    font: regular,
    color: rgb(0.45, 0.5, 0.57),
  });
  const brand = "OXWAY";
  banner.drawText(brand, {
    x: centeredX(bold, brand, 16, A4_WIDTH),
    y: 60,
    size: 16,
    font: bold,
    color: rgb(0.15, 0.39, 0.92),
  });

  const content = await PDFDocument.load(contentPdfBytes);
  const contentPages = await output.copyPages(content, content.getPageIndices());
  contentPages.forEach((page) => output.addPage(page));

  return output.save();
}
