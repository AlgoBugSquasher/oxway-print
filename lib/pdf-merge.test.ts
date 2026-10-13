import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { mergeSelectedPdfPages } from "./pdf-merge";

/** Pages with distinct heights so order/selection can be checked by geometry alone. */
async function buildPdf(heights: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  heights.forEach((height) => doc.addPage([300, height]));
  return doc.save();
}

describe("mergeSelectedPdfPages", () => {
  it("merges files in list order, each file's own selected pages ascending regardless of click order", async () => {
    const fileA = await buildPdf([401, 402, 403]); // 3 pages
    const fileB = await buildPdf([501, 502]); // 2 pages

    const merged = await mergeSelectedPdfPages([
      { fileName: "a.pdf", pdfBytes: fileA, selectedPages: [3, 1] }, // out of order on purpose
      { fileName: "b.pdf", pdfBytes: fileB, selectedPages: [2] },
    ]);

    const doc = await PDFDocument.load(merged.bytes);
    expect(merged.pageCount).toBe(3);
    expect(doc.getPages().map((page) => page.getHeight())).toEqual([401, 403, 502]);
  });

  it("excludes pages that weren't selected", async () => {
    const file = await buildPdf([401, 402, 403, 404]);
    const merged = await mergeSelectedPdfPages([{ fileName: "doc.pdf", pdfBytes: file, selectedPages: [2, 4] }]);
    const doc = await PDFDocument.load(merged.bytes);
    expect(doc.getPages().map((page) => page.getHeight())).toEqual([402, 404]);
  });

  it("skips a file entirely when it has no selected pages, without affecting the others", async () => {
    const fileA = await buildPdf([401]);
    const fileB = await buildPdf([501]);
    const fileC = await buildPdf([601]);

    const merged = await mergeSelectedPdfPages([
      { fileName: "a.pdf", pdfBytes: fileA, selectedPages: [1] },
      { fileName: "b.pdf", pdfBytes: fileB, selectedPages: [] },
      { fileName: "c.pdf", pdfBytes: fileC, selectedPages: [1] },
    ]);

    const doc = await PDFDocument.load(merged.bytes);
    expect(doc.getPages().map((page) => page.getHeight())).toEqual([401, 601]);
  });

  it("preserves each page's own size and orientation — never rotates anything itself", async () => {
    const portrait = await buildPdf([600]); // 300x600, portrait-shaped
    const doc = await PDFDocument.create();
    doc.addPage([600, 300]); // landscape-shaped, built separately for a distinct width too
    const landscape = await doc.save();

    const merged = await mergeSelectedPdfPages([
      { fileName: "portrait.pdf", pdfBytes: portrait, selectedPages: [1] },
      { fileName: "landscape.pdf", pdfBytes: landscape, selectedPages: [1] },
    ]);

    const mergedDoc = await PDFDocument.load(merged.bytes);
    const [page1, page2] = mergedDoc.getPages();
    expect([page1.getWidth(), page1.getHeight()]).toEqual([300, 600]); // untouched
    expect([page2.getWidth(), page2.getHeight()]).toEqual([600, 300]); // untouched
    expect(page1.getRotation().angle).toBe(0);
    expect(page2.getRotation().angle).toBe(0);
  });

  it("merges an image-derived PDF and a Word-derived PDF together", async () => {
    // Mirrors what lib/client-file-converter.ts's imageToPdf actually
    // produces: a single page sized to the target layout with one embedded
    // image filling it. A real browser-decoded image isn't available in
    // this (node, no DOM) test environment, so a plain drawn rectangle
    // stands in for it — mergeSelectedPdfPages only cares that the bytes
    // are a valid PDF page, never what produced them.
    const imageDoc = await PDFDocument.create();
    const imagePage = imageDoc.addPage([595.28, 841.89]); // A4 portrait, matching imageToPdf's own target size
    imagePage.drawRectangle({ x: 20, y: 20, width: 100, height: 100, borderWidth: 2 });
    const imageDerivedBytes = await imageDoc.save();

    // Mirrors docxToPdf's own output: multi-page A4, plain text.
    const wordDoc = await PDFDocument.create();
    const font = await wordDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i += 1) {
      const page = wordDoc.addPage([595.28, 841.89]);
      page.drawText(`Word page ${i + 1}`, { x: 24, y: 800, size: 11, font });
    }
    const wordDerivedBytes = await wordDoc.save();

    const merged = await mergeSelectedPdfPages([
      { fileName: "photo.jpg", pdfBytes: imageDerivedBytes, selectedPages: [1] },
      { fileName: "report.docx", pdfBytes: wordDerivedBytes, selectedPages: [1, 2] },
    ]);

    expect(merged.pageCount).toBe(3);
    const doc = await PDFDocument.load(merged.bytes);
    expect(doc.getPageCount()).toBe(3);
    doc.getPages().forEach((page) => {
      expect([page.getWidth(), page.getHeight()]).toEqual([595.28, 841.89]);
    });
  });

  it("throws, naming the file, when one file's bytes can't be parsed as a PDF", async () => {
    const goodFile = await buildPdf([401]);
    const corruptBytes = new TextEncoder().encode("this is not a pdf at all, just garbage bytes");

    await expect(mergeSelectedPdfPages([
      { fileName: "fine.pdf", pdfBytes: goodFile, selectedPages: [1] },
      { fileName: "broken.pdf", pdfBytes: corruptBytes, selectedPages: [1] },
    ])).rejects.toThrow(/broken\.pdf/);
  });

  it("throws when no pages are selected across any file", async () => {
    const file = await buildPdf([401, 402]);
    await expect(mergeSelectedPdfPages([{ fileName: "doc.pdf", pdfBytes: file, selectedPages: [] }])).rejects.toThrow(/no pages/i);
    await expect(mergeSelectedPdfPages([])).rejects.toThrow(/no pages/i);
  });

  it("ignores out-of-range page numbers rather than throwing", async () => {
    const file = await buildPdf([401, 402]);
    const merged = await mergeSelectedPdfPages([{ fileName: "doc.pdf", pdfBytes: file, selectedPages: [1, 99] }]);
    expect(merged.pageCount).toBe(1);
  });
});
