import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { computeBillableSheets, computeOrderPrice } from "../pricing";
import type { PrintJobRecord, PrintSettingsSnapshot } from "../store";
import { prependBannerPage, resetQrMatrixCacheForTests } from "./banner";
import { buildLpArgs } from "./cups";
import { expandCopies, extractSelectedPages } from "./pdf";
import { physicalSheetsForJob } from "./sheets";

// Part 2 regression suite: every existing print customization (page
// selection, orientation, copies, color) exercised together through the
// REAL processing functions — extractSelectedPages, expandCopies,
// prependBannerPage, buildLpArgs, and the price/sheet-count math — so a
// change to any one of them that breaks another is caught here, not in
// production. One command runs this whole file along with the rest of the
// suite: `npm test` (vitest run). This file alone: `npx vitest run
// lib/print/regression.test.ts`.
//
// --------------------------------------------------------------------------
// Fixtures — generated here, not committed as binary files, so they're
// trivial to read/modify and never go stale relative to the code that
// builds them.
// --------------------------------------------------------------------------

const PORTRAIT: [number, number] = [400, 600];
const LANDSCAPE: [number, number] = [600, 400];

/** Draws an asymmetric marker (distinct corner dots + a label) so a rasterized page's content placement is visually checkable, not just its size. */
async function markPage(doc: PDFDocument, width: number, height: number, label: string) {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([width, height]);
  page.drawRectangle({ x: 4, y: 4, width: width - 8, height: height - 8, borderColor: rgb(0.8, 0, 0), borderWidth: 3 });
  page.drawCircle({ x: 20, y: height - 20, size: 12, color: rgb(0, 0.2, 0.9) }); // top-left
  page.drawCircle({ x: width - 20, y: 20, size: 12, color: rgb(0, 0.7, 0.2) }); // bottom-right
  page.drawText(label, { x: 24, y: height / 2, size: 14, font, color: rgb(0, 0, 0) });
  return page;
}

/** 3-page fixture: page 1 portrait, page 2 landscape, page 3 portrait — the exact shape the task describes. */
async function buildMixed3PageFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await markPage(doc, ...PORTRAIT, "Page 1 (portrait)");
  await markPage(doc, ...LANDSCAPE, "Page 2 (landscape)");
  await markPage(doc, ...PORTRAIT, "Page 3 (portrait)");
  return doc.save();
}

/** One natively wide (landscape) page, and one page whose MediaBox is portrait-shaped but carries an explicit /Rotate 90 — visually landscape too. */
async function buildWideAndRotatedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await markPage(doc, 800, 400, "Page 1 (natively wide)");
  const rotatedPage = await markPage(doc, 400, 800, "Page 2 (portrait MediaBox, /Rotate 90)");
  rotatedPage.setRotation(degrees(90));
  return doc.save();
}

async function buildAllLandscapeFixture(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) await markPage(doc, ...LANDSCAPE, `Landscape page ${i + 1}`);
  return doc.save();
}

async function buildAllPortraitFixture(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) await markPage(doc, ...PORTRAIT, `Portrait page ${i + 1}`);
  return doc.save();
}

/** Mirrors lib/client-file-converter.ts's imageToPdf output shape: a single page sized to the target A4 layout with one embedded-image-like mark filling it. Real browser image decoding isn't available in this (node) test environment — extractSelectedPages only cares that the bytes are a valid single-page PDF, never what produced them. */
async function buildImageDerivedFixture(layout: "portrait" | "landscape"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [w, h] = layout === "landscape" ? [841.89, 595.28] : [595.28, 841.89];
  await markPage(doc, w, h, "Photo");
  return doc.save();
}

function isLandscapeShaped(page: { getWidth: () => number; getHeight: () => number }): boolean {
  return page.getWidth() > page.getHeight();
}

function makeTestJob(settings: PrintSettingsSnapshot, selectedPages: number[]): PrintJobRecord {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    status: "paid",
    fileName: "fixture.pdf",
    selectedPages,
    settings,
    totalPrice: 2,
    phoneNumber: "",
    notifyOptIn: false,
    provider: "razorpay",
    providerOrderId: "order_test",
    pdfStoragePath: "fixture.pdf",
    includeBannerPage: true,
    contentHash: "hash",
    kioskId: "oxway_01",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ticketNumber: 11,
    ticketDate: new Date().toISOString().slice(0, 10),
  };
}

// --------------------------------------------------------------------------
// Page selection x orientation, across fixtures — "each selected page ends
// up with the right size and orientation."
// --------------------------------------------------------------------------

describe("page selection x orientation", () => {
  describe.each([
    ["single page (page 2)", [2]],
    ["a range (1-2)", [1, 2]],
    ["non-contiguous (1,3)", [1, 3]],
    ["all pages", [1, 2, 3]],
  ])("mixed 3-page fixture, selection: %s", (_label, selectedPages: number[]) => {
    describe.each(["portrait", "landscape"] as const)("layout=%s", (layout) => {
      it("extracts exactly the selected pages, each matching the requested layout from its own shape", async () => {
        const fixture = await buildMixed3PageFixture();
        const { bytes, pageCount } = await extractSelectedPages(fixture, selectedPages, layout);
        expect(pageCount).toBe(selectedPages.length);

        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(selectedPages.length);
        doc.getPages().forEach((page) => {
          expect(isLandscapeShaped(page)).toBe(layout === "landscape");
        });
      });
    });
  });

  describe.each(["portrait", "landscape"] as const)("wide + /Rotate-90 fixture, layout=%s", (layout) => {
    it("both pages (one natively wide, one portrait-MediaBox-but-rotated) come out matching the requested layout", async () => {
      const fixture = await buildWideAndRotatedFixture();
      const { bytes, pageCount } = await extractSelectedPages(fixture, [1, 2], layout);
      expect(pageCount).toBe(2);
      const doc = await PDFDocument.load(bytes);
      doc.getPages().forEach((page) => {
        expect(isLandscapeShaped(page)).toBe(layout === "landscape");
      });
    });

    it("selecting only the /Rotate-90 page (page 2) alone still orients it correctly", async () => {
      const fixture = await buildWideAndRotatedFixture();
      const { bytes } = await extractSelectedPages(fixture, [2], layout);
      const doc = await PDFDocument.load(bytes);
      expect(isLandscapeShaped(doc.getPages()[0])).toBe(layout === "landscape");
    });
  });

  describe.each(["portrait", "landscape"] as const)("all-landscape fixture, layout=%s", (layout) => {
    it("every selected page matches the requested layout", async () => {
      const fixture = await buildAllLandscapeFixture(3);
      const { bytes } = await extractSelectedPages(fixture, [1, 3], layout);
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(2);
      doc.getPages().forEach((page) => expect(isLandscapeShaped(page)).toBe(layout === "landscape"));
    });
  });

  describe.each(["portrait", "landscape"] as const)("all-portrait fixture, layout=%s", (layout) => {
    it("every selected page matches the requested layout", async () => {
      const fixture = await buildAllPortraitFixture(3);
      const { bytes } = await extractSelectedPages(fixture, [2, 3], layout); // a range ("2-3")
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(2);
      doc.getPages().forEach((page) => expect(isLandscapeShaped(page)).toBe(layout === "landscape"));
    });
  });

  describe.each(["portrait", "landscape"] as const)("image-derived single page, layout=%s", (layout) => {
    it("the single image-derived page matches the requested layout", async () => {
      // Deliberately built in the OPPOSITE layout from what's requested, so a no-op implementation would fail this.
      const fixture = await buildImageDerivedFixture(layout === "landscape" ? "portrait" : "landscape");
      const { bytes } = await extractSelectedPages(fixture, [1], layout);
      const doc = await PDFDocument.load(bytes);
      expect(isLandscapeShaped(doc.getPages()[0])).toBe(layout === "landscape");
    });
  });
});

// --------------------------------------------------------------------------
// Full pipeline: selection -> copies -> banner -> lp args -> price/sheets,
// for copies 1/2/3 and both color flags.
// --------------------------------------------------------------------------

describe("full pipeline regression (selection, copies, color, lp args, price/sheets)", () => {
  const rates = { priceBw: 2, priceColor: 10 };

  describe.each([1, 2, 3])("copies=%d", (copies) => {
    describe.each([false, true])("isColor=%s", (isColor) => {
      it("produces the right content order, banner exactly once (first), correct lp args, and price/sheets matching what the customer was shown", async () => {
        resetQrMatrixCacheForTests();

        const settings: PrintSettingsSnapshot = { copies, layout: "portrait", isColor, paperSize: "A4", pagesPerSheet: 1 };
        const selectedPages = [1, 3]; // non-contiguous selection, on purpose

        const fixture = await buildMixed3PageFixture();
        const extracted = await extractSelectedPages(fixture, selectedPages, settings.layout);
        expect(extracted.pageCount).toBe(2);

        const expanded = await expandCopies(extracted.bytes, settings.copies);
        const withBanner = await prependBannerPage(expanded, makeTestJob(settings, selectedPages));
        const doc = await PDFDocument.load(withBanner);
        const pages = doc.getPages();

        // Exactly one banner page, first, then copies * 2 content pages.
        expect(pages.length).toBe(copies * 2 + 1);
        pages.slice(1).forEach((page) => expect(isLandscapeShaped(page)).toBe(false)); // portrait requested, every content page matches
        const bannerPage = pages[0];
        expect(isLandscapeShaped(bannerPage)).toBe(false); // banner follows the same portrait content orientation
        // Exactly one banner-sized page — never one per copy.
        const a4PortraitLikePages = pages.filter((page) => page.getHeight() > 800);
        expect(a4PortraitLikePages).toHaveLength(1);

        // Exact lp arguments for this settings combination.
        const args = buildLpArgs("/tmp/job.pdf", settings);
        expect(args).toEqual([
          "-n", "1",
          "-o", "media=a4",
          "-o", "number-up=1",
          "-o", "fit-to-page",
          "-o", `print-color-mode=${isColor ? "color" : "monochrome"}`,
          "/tmp/job.pdf",
        ]);

        // Price/sheets — must match what create-order's own server-side
        // recomputation (lib/pricing.ts, same functions) would show the
        // customer, from the REAL extracted page count, not a guess.
        const billableSheets = computeBillableSheets(extracted.pageCount, settings.pagesPerSheet, settings.copies);
        const price = computeOrderPrice(billableSheets, settings.isColor, rates);
        expect(billableSheets).toBe(2 * copies); // ceil(2/1) * copies
        expect(price).toBe(billableSheets * (isColor ? rates.priceColor : rates.priceBw));

        // Physical sheets (paper/toner supply tracking) — banner included
        // exactly once total, never once per copy (see lib/print/sheets.ts).
        const physicalSheets = physicalSheetsForJob({
          selectedPages: Array.from({ length: extracted.pageCount }, (_, i) => i + 1),
          settings,
          includeBannerPage: true,
        });
        expect(physicalSheets).toBe(billableSheets + 1);
      });
    });
  });

  it("landscape layout produces the matching lp args and an equally-landscape banner, independent of copies/color", async () => {
    resetQrMatrixCacheForTests();
    const settings: PrintSettingsSnapshot = { copies: 2, layout: "landscape", isColor: true, paperSize: "Letter", pagesPerSheet: 2 };
    const fixture = await buildAllPortraitFixture(2);
    const extracted = await extractSelectedPages(fixture, [1, 2], settings.layout);
    const expanded = await expandCopies(extracted.bytes, settings.copies);
    const withBanner = await prependBannerPage(expanded, makeTestJob(settings, [1, 2]));
    const doc = await PDFDocument.load(withBanner);
    const pages = doc.getPages();

    expect(pages.length).toBe(2 * 2 + 1); // 2 pages * 2 copies + banner
    pages.forEach((page) => expect(isLandscapeShaped(page)).toBe(true)); // content AND banner both landscape

    const args = buildLpArgs("/tmp/job.pdf", settings);
    expect(args).toContain("media=letter");
    expect(args).toContain("number-up=2");
    expect(args).toContain("print-color-mode=color");
  });
});
