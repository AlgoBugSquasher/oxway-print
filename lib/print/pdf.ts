import { degrees, PDFDocument } from "pdf-lib";
import type { PrintSettingsSnapshot } from "../store";

/**
 * Extracts only the pages the customer selected (in order) from the
 * uploaded PDF, and rotates portrait-dimensioned pages when the customer
 * requested landscape output (ROADMAP.md #15).
 *
 * Rotation is done here, on the PDF page content itself, rather than relying
 * on CUPS's `orientation-requested` option (still set in lib/print/cups.ts)
 * — that flag mostly instructs the printer how paper feeds and doesn't
 * reliably rotate content with a community driver like splix. Setting the
 * PDF page's own /Rotate value is driver-independent: CUPS's own PDF-to-
 * raster filter chain honors it when rasterizing, regardless of what the
 * driver does with the separate IPP attribute.
 *
 * NOT handled here (out of scope for the documented bug): a source page
 * that's already landscape-dimensioned with `layout: "portrait"` selected.
 * ROADMAP.md #15 only describes the portrait-source + landscape-setting
 * failure; the symmetric case isn't reported as broken and isn't touched.
 *
 * UNVERIFIED: which rotation direction (clockwise vs counterclockwise)
 * actually reads right on the real ML-1866W + splix combination hasn't been
 * confirmed on physical hardware — 90° clockwise is the common convention
 * and is what's used below, but this needs a real test print to confirm.
 */
export interface ExtractedPdf {
  bytes: Uint8Array;
  /**
   * The true number of pages in the output — not the same as
   * selectedPages.length. Out-of-range page numbers are silently dropped
   * below, so a client-submitted selection can claim more pages than
   * actually end up in the printed file. ROADMAP.md #13's server-side price
   * recalculation (see /api/create-order) bills off this count, not the
   * client's claim, so a bogus page number can't skew the price either way.
   */
  pageCount: number;
}

export async function extractSelectedPages(
  originalBytes: Uint8Array,
  selectedPages: number[],
  layout: PrintSettingsSnapshot["layout"]
): Promise<ExtractedPdf> {
  const source = await PDFDocument.load(originalBytes);
  const output = await PDFDocument.create();

  const sortedPages = [...selectedPages].sort((a, b) => a - b);
  const zeroIndexed = sortedPages
    .map((pageNumber) => pageNumber - 1)
    .filter((index) => index >= 0 && index < source.getPageCount());

  if (zeroIndexed.length === 0) {
    throw new Error("No valid pages selected to print.");
  }

  const copiedPages = await output.copyPages(source, zeroIndexed);
  copiedPages.forEach((page) => {
    if (layout === "landscape") {
      const { width, height } = page.getSize();
      const isPortraitDimensioned = height >= width;
      if (isPortraitDimensioned) page.setRotation(degrees(90));
    }
    output.addPage(page);
  });

  return { bytes: await output.save(), pageCount: output.getPageCount() };
}
