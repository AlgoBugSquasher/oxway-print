import { degrees, PDFDocument } from "pdf-lib";
import type { PrintSettingsSnapshot } from "../store";

/**
 * Extracts only the pages the customer selected (in order) from the
 * uploaded PDF, and rotates portrait-dimensioned pages when the customer
 * requested landscape output (ROADMAP.md #15).
 *
 * ROADMAP.md #15 v1 set the page's /Rotate attribute (`page.setRotation()`)
 * and left `orientation-requested` out of the CUPS args, expecting the
 * printer's PDF-to-raster filter chain to honor /Rotate regardless of the
 * driver. In practice, on this printer's actual CUPS/splix setup, the
 * printed output came out IDENTICAL regardless of the layout setting —
 * meaning /Rotate itself was being silently ignored somewhere in that
 * filter chain, not just misapplied. This version bakes the rotation
 * directly into the page's own content geometry instead (an actual
 * coordinate transform, with the page's own width/height swapped), so
 * there's no separate rotation instruction left for anything to ignore —
 * the content's coordinates already describe the rotated layout.
 *
 * The transform used — draw the embedded source page at
 * `{ x: height, y: 0, rotate: degrees(90) }` onto a new page sized
 * `[height, width]` — is pdf-lib's own rotate-then-translate composition
 * (verified directly against its operator-generation source, not assumed)
 * for exactly the matrix PDF viewers use to bake in a /Rotate=90
 * (clockwise) page: `[0, 1, -1, 0, height, 0]`. The two were checked to
 * produce identical numbers before shipping this.
 *
 * NOT handled here (out of scope for the documented bug): a source page
 * that's already landscape-dimensioned with `layout: "portrait"` selected.
 * ROADMAP.md #15 only describes the portrait-source + landscape-setting
 * failure; the symmetric case isn't reported as broken and isn't touched.
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

  const embeddedPages = await output.embedPdf(source, zeroIndexed);
  embeddedPages.forEach((embeddedPage) => {
    const { width, height } = embeddedPage;
    const isPortraitDimensioned = height >= width;

    if (layout === "landscape" && isPortraitDimensioned) {
      const page = output.addPage([height, width]);
      page.drawPage(embeddedPage, { x: height, y: 0, rotate: degrees(90) });
    } else {
      const page = output.addPage([width, height]);
      page.drawPage(embeddedPage, { x: 0, y: 0 });
    }
  });

  return { bytes: await output.save(), pageCount: output.getPageCount() };
}
