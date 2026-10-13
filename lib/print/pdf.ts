import { degrees, PDFDocument } from "pdf-lib";
import type { PrintSettingsSnapshot } from "../store";

/**
 * Extracts only the pages the customer selected (in order) from the
 * uploaded PDF — AFTER selection, not before — rotating each selected page
 * independently, per page, not once for the whole file, so its own shape
 * matches the customer's chosen Layout (ROADMAP.md #15). A source document
 * mixing portrait- and landscape-shaped pages (e.g. a report with one wide
 * scanned table page) comes out uniformly oriented either way: a
 * portrait-shaped page gets rotated under `layout: "landscape"`, a
 * landscape-shaped page gets rotated under `layout: "portrait"`, and a page
 * that's already the right shape is left alone — all decided per page from
 * that SELECTED page's own actual dimensions, never from the file's first
 * page, never from any page that wasn't selected, and never as a single
 * blanket rule for the whole file. Printing only page 2 of a mixed file
 * uses page 2's own orientation, regardless of what pages 1 or 3 look like.
 *
 * A page's "own actual dimensions" means its effective visible box, not
 * just its raw MediaBox: this uses `page.getCropBox()` (CropBox if the
 * source set one — the region content is actually clipped to when
 * displayed or printed — falling back to MediaBox otherwise, which is
 * pdf-lib's own documented default and exactly what the overwhelming
 * majority of real uploads have anyway, so this changes nothing for them),
 * combined with the page's /Rotate. Both getCropBox() and getRotation()
 * resolve values *inherited* from an ancestor node in the source PDF's own
 * /Pages tree, not just ones set directly on the page object — confirmed
 * directly against pdf-lib's PDFPageLeaf source (Rotate/MediaBox/CropBox
 * all route through its own getInheritableAttribute), not assumed. The
 * extracted page is embedded using that same CropBox as its bounding box
 * (via PDFDocument.embedPages' boundingBoxes parameter, not the embedPdf
 * convenience wrapper, which never exposes one) — so a page's size,
 * rotation and crop all carry over into the selection exactly as they were
 * on the source page, never silently widened back out to the full MediaBox.
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
 * produce identical numbers before shipping this. A page that needs
 * rotating always gets +90 here, regardless of which direction the switch
 * goes (portrait-to-landscape or landscape-to-portrait) — simplest
 * consistent rule, and there's no single "more correct" direction for a
 * page that was never a rotated portrait page to begin with (a natively
 * landscape-shaped page, say) to rotate back the "same way" it came from.
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
 * viewer would show it even before this app's own layout conversion is
 * layered on top.
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

/**
 * Cheap, fast check that the bytes at least *start* like a PDF — the
 * `%PDF` magic header every valid PDF file begins with. Not a full
 * validation (a truncated or corrupted file can still start correctly and
 * fail later) — see extractSelectedPages below, whose own pdf-lib parse
 * failure is the real "is this actually readable" check. This just avoids
 * spending a full parse on something that was never a PDF at all (e.g. a
 * renamed .docx, or a storage upload that silently failed) and lets the
 * caller give a clearer, faster error.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
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

/**
 * Duplicates every page in `pdfBytes` into `copies` consecutive, identical
 * sequences — copy 1's pages in their original 1..N order, then copy 2's,
 * and so on (collated), never page-1-of-every-copy then page-2-of-every-copy.
 *
 * Used so copies can be baked directly into the submitted PDF instead of
 * relying on CUPS's own `-n`/collate handling (see submitPrintJob in
 * lib/print/cups.ts) — specifically so print-agent/index.ts can append a
 * single banner page once, after every copy of the actual content, rather
 * than once per copy, which is what letting CUPS replicate the whole
 * (content + banner) file per copy would otherwise do.
 *
 * `copies <= 1` returns the input unchanged — no need to even parse it.
 */
export async function expandCopies(pdfBytes: Uint8Array, copies: number): Promise<Uint8Array> {
  if (copies <= 1) return pdfBytes;

  const source = await PDFDocument.load(pdfBytes);
  const output = await PDFDocument.create();
  const sourceIndices = source.getPageIndices();

  for (let copy = 0; copy < copies; copy += 1) {
    const pages = await output.copyPages(source, sourceIndices);
    pages.forEach((page) => output.addPage(page));
  }

  return output.save();
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

  // Only the SELECTED pages, in the order they'll be extracted — everything
  // below (bounding box, rotation, orientation) is computed per entry in
  // this array, never against the source document's full page list, which
  // is what makes this genuinely "decided after selection" rather than
  // just "decided per page somewhere in the file."
  const selectedSourcePages = zeroIndexed.map((index) => source.getPage(index));

  // The box each page's content is embedded relative to — CropBox (falls
  // back to MediaBox when unset, see this function's own docstring) rather
  // than always the raw MediaBox embedPdf's convenience wrapper would use.
  // embedPages' boundingBoxes parameter takes this in {left, bottom, right,
  // top} form; passing the CropBox's own (possibly non-zero) origin here —
  // not normalized to 0 — is what makes pdf-lib's own boundingBoxAdjustedMatrix
  // translate the crop's bottom-left corner to the new page's origin,
  // i.e. actually clip to it, not just report its size.
  const boundingBoxes = selectedSourcePages.map((page) => {
    const box = page.getCropBox();
    return { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height };
  });

  const embeddedPages = await output.embedPages(selectedSourcePages, boundingBoxes);
  embeddedPages.forEach((embeddedPage, i) => {
    const { width, height } = embeddedPage;

    // embeddedPage's width/height now come from the CropBox above, not the
    // raw MediaBox — pdf-lib's embedding step ignores /Rotate entirely (see
    // this function's own docstring), so a pre-rotated source's true visual
    // shape needs the raw dimensions swapped, same as a normal PDF viewer
    // would show it, before deciding whether it still needs *our* own
    // layout conversion on top.
    const sourceRotation = normalizeRotation(selectedSourcePages[i].getRotation().angle);
    const sourceRotationSwapsAxes = sourceRotation === 90 || sourceRotation === 270;
    const visualWidth = sourceRotationSwapsAxes ? height : width;
    const visualHeight = sourceRotationSwapsAxes ? width : height;
    const isPortraitDimensioned = visualHeight >= visualWidth;

    // Symmetric, per-page decision: rotate whenever this page's own shape
    // doesn't already match the requested layout — portrait-shaped but
    // landscape requested, or landscape-shaped but portrait requested.
    // Each page is judged purely on its own isPortraitDimensioned value,
    // so a document mixing both shapes comes out uniformly oriented
    // either way, not just when Landscape happens to be selected.
    const wantsLandscapeOutput = layout === "landscape";
    const needsRotation = isPortraitDimensioned === wantsLandscapeOutput;
    const totalRotation = normalizeRotation(sourceRotation + (needsRotation ? 90 : 0));

    const { pageSize, x, y } = placementForRotation(width, height, totalRotation);
    const page = output.addPage(pageSize);
    page.drawPage(embeddedPage, { x, y, rotate: degrees(totalRotation) });
  });

  return { bytes: await output.save(), pageCount: output.getPageCount() };
}
