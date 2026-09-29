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
 * Also accounts for a source page's own pre-existing `/Rotate` entry (e.g.
 * a phone-scanned marksheet/certificate) — pdf-lib's page embedding ignores
 * it entirely otherwise: `PDFPageEmbedder` (pdf-lib's own embedding
 * implementation) computes the embedded page's width/height from the raw
 * `/MediaBox` and embeds its content with a pure-translation matrix, no
 * rotation term at all (verified directly against that source, not
 * assumed). Left alone, that meant any source page with its own rotation
 * printed wrong regardless of this app's layout setting — landscape or
 * portrait — since neither branch here ever looked at it. Each page's own
 * rotation (read via `getRotation()`) is now folded into the same total
 * rotation applied below, so a pre-rotated source prints the way a normal
 * viewer would show it even before this app's own landscape conversion is
 * layered on top.
 *
 * NOT handled here (out of scope for the documented bug): a source page
 * that's already landscape-dimensioned (after accounting for its own
 * rotation) with `layout: "portrait"` selected. ROADMAP.md #15 only
 * describes the portrait-source + landscape-setting failure; the symmetric
 * case isn't reported as broken and isn't touched.
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

type PageRotation = 0 | 90 | 180 | 270;

/** Folds any angle (a source page's raw `/Rotate`, or that plus our own +90) back into the canonical four pdf-lib itself restricts page rotations to. */
function normalizeRotation(angleDegrees: number): PageRotation {
  return (((angleDegrees % 360) + 360) % 360) as PageRotation;
}

/**
 * The (x, y) offset `page.drawPage(embeddedPage, { x, y, rotate })` needs so
 * a `width`×`height` source box, rotated by `rotationDegrees` around the
 * origin, lands exactly on a same-sized-or-swapped destination page with no
 * gap or overhang — i.e. the actual geometry a baked-in `/Rotate` of that
 * amount would produce. Only the 90° case was previously derivable by
 * inspection (it shipped and was verified against pdf-lib's own operator
 * output); 0/180/270 here are the same rotate-then-translate matrix used by
 * `PDFPage.drawPage` (translate ∘ rotate — see pdf-lib's `operations.ts`),
 * solved for the offset that maps the source box's post-rotation bounding
 * corner back to the destination's origin.
 *
 * These four were cross-checked with a small standalone script (not kept in
 * the repo) that derives the offset mechanically from the same matrix
 * rather than by hand — worth re-deriving that way again if this ever needs
 * touching, since the first hand-derivation of the 270° case had a sign
 * error that only showed up when a test render came out blank (the offset
 * placed the content entirely outside the page).
 */
function placementForRotation(width: number, height: number, rotationDegrees: PageRotation): { pageSize: [number, number]; x: number; y: number } {
  switch (rotationDegrees) {
    case 0: return { pageSize: [width, height], x: 0, y: 0 };
    case 90: return { pageSize: [height, width], x: height, y: 0 };
    case 180: return { pageSize: [width, height], x: width, y: height };
    case 270: return { pageSize: [height, width], x: 0, y: width };
  }
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
  embeddedPages.forEach((embeddedPage, i) => {
    const { width, height } = embeddedPage;

    // embeddedPage's width/height are the source page's raw /MediaBox —
    // pdf-lib's embedding step ignores /Rotate entirely (see this
    // function's own docstring), so a pre-rotated source's true visual
    // shape needs the raw dimensions swapped, same as a normal PDF viewer
    // would show it, before deciding whether it still needs *our*
    // landscape conversion on top.
    const sourceRotation = normalizeRotation(source.getPage(zeroIndexed[i]).getRotation().angle);
    const sourceRotationSwapsAxes = sourceRotation === 90 || sourceRotation === 270;
    const visualWidth = sourceRotationSwapsAxes ? height : width;
    const visualHeight = sourceRotationSwapsAxes ? width : height;
    const isPortraitDimensioned = visualHeight >= visualWidth;

    const needsLandscapeRotation = layout === "landscape" && isPortraitDimensioned;
    const totalRotation = normalizeRotation(sourceRotation + (needsLandscapeRotation ? 90 : 0));

    const { pageSize, x, y } = placementForRotation(width, height, totalRotation);
    const page = output.addPage(pageSize);
    page.drawPage(embeddedPage, { x, y, rotate: degrees(totalRotation) });
  });

  return { bytes: await output.save(), pageCount: output.getPageCount() };
}
