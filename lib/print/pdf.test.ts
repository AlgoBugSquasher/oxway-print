import { PDFDocument, degrees, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { expandCopies, extractSelectedPages, looksLikePdf } from "./pdf";

/** Pages with distinct heights so order/repetition can be checked by geometry alone. */
async function buildPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([300, 401 + i]);
  return doc.save();
}

/**
 * Builds a PDF whose pages have the given [width, height] shapes, in
 * order. Each page gets a trivial mark drawn on it — pdf-lib's embedPdf
 * (what extractSelectedPages uses) requires a page to actually have a
 * content stream, which doc.addPage alone doesn't create.
 */
async function buildShapedPdf(shapes: Array<[number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  shapes.forEach(([width, height]) => {
    const page = doc.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(0, 0, 0) });
  });
  return doc.save();
}

describe("looksLikePdf", () => {
  it("accepts bytes starting with the %PDF magic header", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n...rest of a real pdf...");
    expect(looksLikePdf(bytes)).toBe(true);
  });

  it("rejects bytes that don't start with %PDF — e.g. a renamed non-PDF file", () => {
    const bytes = new TextEncoder().encode("PK\x03\x04 this is actually a zip/docx");
    expect(looksLikePdf(bytes)).toBe(false);
  });

  it("rejects an empty or truncated upload rather than throwing on out-of-bounds access", () => {
    expect(looksLikePdf(new Uint8Array())).toBe(false);
    expect(looksLikePdf(new Uint8Array([0x25, 0x50]))).toBe(false); // "%P", cut short
  });
});

describe("expandCopies", () => {
  it("returns the input unchanged for 1 copy (and 0, as a defensive floor)", async () => {
    const original = await buildPdf(2);
    expect(await expandCopies(original, 1)).toBe(original);
    expect(await expandCopies(original, 0)).toBe(original);
  });

  it("repeats every page copies times, each copy in its original 1..N order (collated, not interleaved)", async () => {
    const original = await buildPdf(3); // heights 401, 402, 403
    const expanded = await expandCopies(original, 3);
    const doc = await PDFDocument.load(expanded);
    expect(doc.getPageCount()).toBe(9);
    expect(doc.getPages().map((page) => page.getHeight())).toEqual([401, 402, 403, 401, 402, 403, 401, 402, 403]);
  });

  it("works for a single-page document too", async () => {
    const original = await buildPdf(1);
    const expanded = await expandCopies(original, 4);
    const doc = await PDFDocument.load(expanded);
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPages().map((page) => page.getHeight())).toEqual([401, 401, 401, 401]);
  });
});

describe("extractSelectedPages — mixed-orientation rotation", () => {
  const PORTRAIT: [number, number] = [400, 600];
  const LANDSCAPE: [number, number] = [600, 400];

  describe.each([
    ["landscape", LANDSCAPE],
    ["portrait", PORTRAIT],
  ] as const)("layout=%s", (layout, [expectedWidth, expectedHeight]) => {
    it("rotates every page — independently, per page, not once for the whole file — so a document mixing portrait- and landscape-shaped pages comes out uniformly oriented", async () => {
      const source = await buildShapedPdf([PORTRAIT, LANDSCAPE, PORTRAIT, LANDSCAPE]);
      const { bytes, pageCount } = await extractSelectedPages(source, [1, 2, 3, 4], layout);
      expect(pageCount).toBe(4);

      const doc = await PDFDocument.load(bytes);
      for (const page of doc.getPages()) {
        expect(page.getWidth()).toBe(expectedWidth);
        expect(page.getHeight()).toBe(expectedHeight);
      }
    });
  });

  it("leaves an all-portrait document's page sizes untouched when portrait is requested (single-orientation files: no behavior change)", async () => {
    const source = await buildShapedPdf([PORTRAIT, PORTRAIT, PORTRAIT]);
    const { bytes } = await extractSelectedPages(source, [1, 2, 3], "portrait");
    const doc = await PDFDocument.load(bytes);
    for (const page of doc.getPages()) {
      expect([page.getWidth(), page.getHeight()]).toEqual(PORTRAIT);
    }
  });

  it("leaves an all-landscape document's page sizes untouched when landscape is requested (single-orientation files: no behavior change)", async () => {
    const source = await buildShapedPdf([LANDSCAPE, LANDSCAPE]);
    const { bytes } = await extractSelectedPages(source, [1, 2], "landscape");
    const doc = await PDFDocument.load(bytes);
    for (const page of doc.getPages()) {
      expect([page.getWidth(), page.getHeight()]).toEqual(LANDSCAPE);
    }
  });

  it("still rotates a uniformly portrait document to landscape on request — pre-existing, single-direction behavior stays correct", async () => {
    const source = await buildShapedPdf([PORTRAIT, PORTRAIT]);
    const { bytes } = await extractSelectedPages(source, [1, 2], "landscape");
    const doc = await PDFDocument.load(bytes);
    for (const page of doc.getPages()) {
      expect([page.getWidth(), page.getHeight()]).toEqual(LANDSCAPE);
    }
  });

  it("now also rotates a uniformly landscape document to portrait on request — the fixed, previously-missing direction", async () => {
    const source = await buildShapedPdf([LANDSCAPE, LANDSCAPE]);
    const { bytes } = await extractSelectedPages(source, [1, 2], "portrait");
    const doc = await PDFDocument.load(bytes);
    for (const page of doc.getPages()) {
      expect([page.getWidth(), page.getHeight()]).toEqual(PORTRAIT);
    }
  });

  it("decides orientation only from the SELECTED page — printing only page 2 of a mixed file uses page 2's own shape, regardless of pages 1/3", async () => {
    const source = await buildShapedPdf([PORTRAIT, LANDSCAPE, PORTRAIT]);
    const { bytes, pageCount } = await extractSelectedPages(source, [2], "portrait");
    expect(pageCount).toBe(1);
    const doc = await PDFDocument.load(bytes);
    // Page 2 is landscape-shaped in the source; portrait was requested, so
    // it must be rotated — this only works if the decision was made from
    // page 2 itself, not from page 1 (which was never even selected).
    expect([doc.getPages()[0].getWidth(), doc.getPages()[0].getHeight()]).toEqual(PORTRAIT);
  });
});

describe("extractSelectedPages — CropBox-aware effective size", () => {
  const LANDSCAPE: [number, number] = [600, 400];

  /** A page whose raw MediaBox is `mediaBox`-shaped but whose CropBox clips to a `cropBox`-shaped region starting at the given offset — the effective, visible page shape a real viewer or printer would use. */
  async function buildCroppedPdf(mediaBox: [number, number], crop: { x: number; y: number; width: number; height: number }, rotateDegrees = 0): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage(mediaBox);
    page.drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(0, 0, 0) });
    page.setCropBox(crop.x, crop.y, crop.width, crop.height);
    if (rotateDegrees) page.setRotation(degrees(rotateDegrees));
    return doc.save();
  }

  it("judges orientation from the CropBox, not the full MediaBox, when they differ", async () => {
    // MediaBox is landscape (800x500), but the CropBox clips it down to a
    // portrait-shaped (400x500) region — a real printer/viewer only ever
    // shows that cropped region, so THAT'S what "landscape or portrait"
    // should mean here, not the raw, larger MediaBox.
    const source = await buildCroppedPdf([800, 500], { x: 0, y: 0, width: 400, height: 500 });
    const { bytes } = await extractSelectedPages(source, [1], "portrait");
    const doc = await PDFDocument.load(bytes);
    // Already portrait-shaped per its CropBox, so it should be left alone (400x500), not rotated.
    expect([doc.getPages()[0].getWidth(), doc.getPages()[0].getHeight()]).toEqual([400, 500]);
  });

  it("rotates based on the CropBox's shape when the CropBox and MediaBox disagree on orientation", async () => {
    // MediaBox is portrait (500x800); CropBox clips to a landscape-shaped
    // (500x300) strip within it. Landscape requested: since the CropBox is
    // already landscape-shaped, no rotation should be applied — a
    // MediaBox-only implementation would incorrectly think this page is
    // portrait-shaped (800 tall) and rotate it unnecessarily.
    const source = await buildCroppedPdf([500, 800], { x: 0, y: 0, width: 500, height: 300 });
    const { bytes } = await extractSelectedPages(source, [1], "landscape");
    const doc = await PDFDocument.load(bytes);
    expect([doc.getPages()[0].getWidth(), doc.getPages()[0].getHeight()]).toEqual([500, 300]);
  });

  it("preserves the CropBox's own dimensions in the extracted output — never silently widens back out to the full MediaBox", async () => {
    const source = await buildCroppedPdf([800, 500], { x: 50, y: 25, width: 400, height: 450 });
    const { bytes } = await extractSelectedPages(source, [1], "portrait");
    const doc = await PDFDocument.load(bytes);
    const [width, height] = [doc.getPages()[0].getWidth(), doc.getPages()[0].getHeight()];
    expect([width, height].sort((a, b) => a - b)).toEqual([400, 450].sort((a, b) => a - b));
  });

  it("falls back to MediaBox when no CropBox is set — no behavior change for the overwhelming majority of real uploads, which never set one", async () => {
    const source = await buildShapedPdf([LANDSCAPE]);
    const { bytes } = await extractSelectedPages(source, [1], "landscape");
    const doc = await PDFDocument.load(bytes);
    expect([doc.getPages()[0].getWidth(), doc.getPages()[0].getHeight()]).toEqual(LANDSCAPE);
  });

  it("combines CropBox with an explicit /Rotate 90 — a portrait-cropped region on a page rotated 90° is visually landscape", async () => {
    // CropBox is 400x600 (portrait) on the page's own unrotated axes, but
    // /Rotate 90 means a viewer swaps width/height when displaying it —
    // visually landscape (600x400). Requesting landscape should leave it
    // untouched; requesting portrait should rotate it.
    const sourceLandscapeRequested = await buildCroppedPdf([400, 600], { x: 0, y: 0, width: 400, height: 600 }, 90);
    const landscapeResult = await extractSelectedPages(sourceLandscapeRequested, [1], "landscape");
    const landscapeDoc = await PDFDocument.load(landscapeResult.bytes);
    const landscapePage = landscapeDoc.getPages()[0];
    expect(landscapePage.getWidth()).toBeGreaterThan(landscapePage.getHeight());

    const sourcePortraitRequested = await buildCroppedPdf([400, 600], { x: 0, y: 0, width: 400, height: 600 }, 90);
    const portraitResult = await extractSelectedPages(sourcePortraitRequested, [1], "portrait");
    const portraitDoc = await PDFDocument.load(portraitResult.bytes);
    const portraitPage = portraitDoc.getPages()[0];
    expect(portraitPage.getHeight()).toBeGreaterThan(portraitPage.getWidth());
  });
});
