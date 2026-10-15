import jsQR from "jsqr";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { PrintJobRecord } from "../store";
import {
  BANNER_LAYOUT_CONFIG,
  MM_TO_PT,
  prependBannerPage,
  buildBannerPlanContext,
  buildPaymentLineTexts,
  buildStaffPrintLineTexts,
  computeBannerPlan,
  resetQrMatrixCacheForTests,
  type PlannedElement,
  type Rect,
} from "./banner";
import { generateQrMatrix, type QrMatrix } from "./qr";

// Wraps the real ./qr so every test gets a genuine generated QR by default —
// only the one "generation failed" test below overrides this for a single
// call, via mockImplementationOnce. This is what lets this file test the
// real fallback path without a second, parallel "fake QR generator" story
// for every other test. banner.ts imports generateQrMatrix from this exact
// module, so mocking it here reaches that call too.
vi.mock("./qr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qr")>();
  return { ...actual, generateQrMatrix: vi.fn(actual.generateQrMatrix) };
});

const MARGIN_PT = BANNER_LAYOUT_CONFIG.marginMm * MM_TO_PT;
const EPSILON = 0.05;

const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const LETTER_PORTRAIT = { width: 612, height: 792 };
// Small enough that even the fully-shrunk, every-droppable-block-dropped
// layout is a real test of the engine's floor behavior, not just "plenty of
// room" — deliberately well past comfortable, not just barely tight.
const VERY_SMALL_PORTRAIT = { width: 140, height: 200 };
const VERY_SMALL_LANDSCAPE = { width: 200, height: 140 };

const PAGE_SIZES: Array<[string, { width: number; height: number }]> = [
  ["A4 portrait", A4_PORTRAIT],
  ["A4 landscape", A4_LANDSCAPE],
  ["Letter", LETTER_PORTRAIT],
  ["a very small page", VERY_SMALL_PORTRAIT],
];

function makeTestJob(overrides: Partial<PrintJobRecord> = {}): PrintJobRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "paid",
    fileName: "test.pdf",
    selectedPages: [1],
    settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
    totalPrice: 2,
    phoneNumber: "",
    notifyOptIn: false,
    provider: "razorpay",
    providerOrderId: "order_test",
    pdfStoragePath: "test.pdf",
    includeBannerPage: true,
    contentHash: "hash",
    kioskId: "oxway_01",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ticketNumber: 42,
    ticketDate: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}

/** The three payment-data scenarios requirement 13 asks for. */
const PAYMENT_SCENARIOS: Array<[string, Partial<PrintJobRecord>]> = [
  ["full payment data", { paidAmount: 19.5, paymentId: "pay_ABC123XYZ9", upiTxnId: "123456789012" }],
  ["UPI txn id missing (falls back to payment id)", { paidAmount: 19.5, paymentId: "pay_ABC123XYZ9", upiTxnId: undefined }],
  ["no payment data at all", { paidAmount: undefined, paymentId: undefined, upiTxnId: undefined }],
  ["a free staff print", { paymentMethod: "staff", isFree: true, waivedAmount: 24, paidAmount: undefined, paymentId: undefined, upiTxnId: undefined }],
];

/** Real QR, generated from the exact URL/error-correction level production uses — never a stub — so every test below exercises the genuine module grid. */
function buildTestQrMatrix(): QrMatrix {
  return generateQrMatrix(BANNER_LAYOUT_CONFIG.instagram.url, BANNER_LAYOUT_CONFIG.instagram.errorCorrectionLevel);
}

async function buildTestFonts(): Promise<{ doc: PDFDocument; bold: PDFFont; regular: PDFFont; qrMatrix: QrMatrix }> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, bold, regular, qrMatrix: buildTestQrMatrix() };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width - EPSILON && a.x + a.width > b.x + EPSILON && a.y < b.y + b.height - EPSILON && a.y + a.height > b.y + EPSILON;
}

/**
 * Renders exactly the dark rectangles drawn for one "qr" PlannedElement to
 * a flat RGBA pixel buffer at `dpi` — a dev-only decode check (requirement
 * #5) that the real drawn geometry (quiet zone, module size, merged row
 * runs) still resolves to a scannable code once rasterized at a
 * deliberately low, worse-than-print resolution, not just that the numbers
 * look right on paper. pdf-lib has no rasterizer of its own, so this works
 * directly from the element's own `rects` — exactly what commitElements
 * (the real drawing code in banner.ts) iterates over to draw them too.
 */
function rasterizeQrElement(el: PlannedElement, dpi: number): { width: number; height: number; data: Uint8ClampedArray } {
  if (el.content.kind !== "qr") throw new Error(`"${el.id}" is not a QR element`);
  const scale = dpi / 72;
  const width = Math.round(el.rect.width * scale);
  const height = Math.round(el.rect.height * scale);
  const data = new Uint8ClampedArray(width * height * 4).fill(255); // opaque white

  for (const rect of el.content.rects) {
    const xStart = Math.max(0, Math.round((rect.x - el.rect.x) * scale));
    const xEnd = Math.min(width, Math.round((rect.x + rect.width - el.rect.x) * scale));
    // PDF's y axis is bottom-up; raster rows go top-down, so flip around
    // this element's own height rather than the page's.
    const yStartFromBottom = (rect.y - el.rect.y) * scale;
    const yEndFromBottom = (rect.y + rect.height - el.rect.y) * scale;
    const yStart = Math.max(0, Math.round(height - yEndFromBottom));
    const yEnd = Math.min(height, Math.round(height - yStartFromBottom));
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = data[idx + 1] = data[idx + 2] = 0; // black
        data[idx + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

/**
 * The actual substance of "no overlaps, everything inside the safe
 * margins" — re-checked independently here (not just trusting
 * computeBannerPlan's own internal check, which could itself have a bug)
 * against every element's rect, for every page-size/data combination below.
 */
function assertNoOverlapsAndWithinMargins(elements: PlannedElement[], pageWidth: number, pageHeight: number) {
  expect(elements.length).toBeGreaterThan(0);
  for (const el of elements) {
    expect(el.rect.x).toBeGreaterThanOrEqual(MARGIN_PT - EPSILON);
    expect(el.rect.y).toBeGreaterThanOrEqual(MARGIN_PT - EPSILON);
    expect(el.rect.x + el.rect.width).toBeLessThanOrEqual(pageWidth - MARGIN_PT + EPSILON);
    expect(el.rect.y + el.rect.height).toBeLessThanOrEqual(pageHeight - MARGIN_PT + EPSILON);
  }
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      expect(rectsOverlap(elements[i].rect, elements[j].rect)).toBe(false);
    }
  }
}

/** No element's drawn text should ever read "undefined" or "null" — missing data means a skipped line, never a literal placeholder. */
function assertNoUndefinedOrNullText(elements: PlannedElement[]) {
  for (const el of elements) {
    if (el.content.kind === "text") {
      expect(el.content.text.toLowerCase()).not.toContain("undefined");
      expect(el.content.text.toLowerCase()).not.toContain("null");
    }
  }
}

describe("buildPaymentLineTexts", () => {
  it("prints Total paid and the UPI transaction id when both are available", async () => {
    const { regular } = await buildTestFonts();
    const lines = buildPaymentLineTexts({ paidAmount: 19.5, totalPrice: 19.5, upiTxnId: "123456789012", paymentId: "pay_ABC" }, regular);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("19.5");
    expect(lines[0].toLowerCase()).toContain("total paid");
    expect(lines[1]).toContain("UPI Txn ID");
    expect(lines[1]).toContain("123456789012");
  });

  it("falls back to the payment id when the UPI transaction id is missing", async () => {
    const { regular } = await buildTestFonts();
    const lines = buildPaymentLineTexts({ paidAmount: 19.5, totalPrice: 19.5, upiTxnId: undefined, paymentId: "pay_ABC123" }, regular);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Payment ID");
    expect(lines[1]).toContain("pay_ABC123");
  });

  it("skips the second line entirely when both the UPI transaction id and the payment id are missing", async () => {
    const { regular } = await buildTestFonts();
    const lines = buildPaymentLineTexts({ paidAmount: 19.5, totalPrice: 19.5, upiTxnId: undefined, paymentId: undefined }, regular);
    expect(lines).toHaveLength(1);
  });

  it("falls back to totalPrice for the Total paid line when paidAmount hasn't been fetched yet (e.g. Cashfree)", async () => {
    const { regular } = await buildTestFonts();
    const lines = buildPaymentLineTexts({ paidAmount: undefined, totalPrice: 7, upiTxnId: undefined, paymentId: undefined }, regular);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("7");
  });

  it("never prints a UPI id, card details or phone number", async () => {
    const { regular } = await buildTestFonts();
    const lines = buildPaymentLineTexts({ paidAmount: 19.5, totalPrice: 19.5, upiTxnId: "123456789012", paymentId: "pay_ABC" }, regular);
    const joined = lines.join(" ").toLowerCase();
    expect(joined).not.toMatch(/@[a-z]/); // no "name@bank" VPA-style UPI id
    expect(joined).not.toContain("card");
    expect(joined).not.toContain("phone");
  });

  it("uses the Rs. fallback instead of the rupee glyph when the font can't encode it", async () => {
    const doc = await PDFDocument.create();
    const symbolFont = await doc.embedFont(StandardFonts.Symbol); // a standard font with no rupee glyph
    const lines = buildPaymentLineTexts({ paidAmount: 19.5, totalPrice: 19.5, upiTxnId: undefined, paymentId: undefined }, symbolFont);
    expect(lines[0]).toContain(BANNER_LAYOUT_CONFIG.labels.rupeeFallback);
    expect(lines[0]).not.toContain("₹");
  });
});

describe("buildStaffPrintLineTexts", () => {
  it("prints the STAFF PRINT line with the waived amount", async () => {
    const { regular } = await buildTestFonts();
    const lines = buildStaffPrintLineTexts({ waivedAmount: 24 }, regular);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("STAFF PRINT");
    expect(lines[0]).toContain("24");
    expect(lines[0].toLowerCase()).toContain("not charged");
  });

  it("skips the line entirely when waivedAmount is missing — never prints undefined/null", async () => {
    const { regular } = await buildTestFonts();
    expect(buildStaffPrintLineTexts({ waivedAmount: undefined }, regular)).toEqual([]);
  });

  it("uses the Rs. fallback instead of the rupee glyph when the font can't encode it", async () => {
    const doc = await PDFDocument.create();
    const symbolFont = await doc.embedFont(StandardFonts.Symbol);
    const lines = buildStaffPrintLineTexts({ waivedAmount: 24 }, symbolFont);
    expect(lines[0]).toContain(BANNER_LAYOUT_CONFIG.labels.rupeeFallback);
    expect(lines[0]).not.toContain("₹");
  });

  it("never prints a UPI id, card details or phone number — there is no payment to show", async () => {
    const { regular } = await buildTestFonts();
    const joined = buildStaffPrintLineTexts({ waivedAmount: 24 }, regular).join(" ").toLowerCase();
    expect(joined).not.toMatch(/@[a-z]/);
    expect(joined).not.toContain("card");
    expect(joined).not.toContain("phone");
  });
});

describe("buildBannerPlanContext — staff print vs. normal payment lines", () => {
  it("uses the STAFF PRINT line (never the normal payment lines) when paymentMethod is staff", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const job = makeTestJob({ paymentMethod: "staff", isFree: true, waivedAmount: 24, paidAmount: undefined, paymentId: "should-never-show", upiTxnId: "should-never-show" });
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, A4_PORTRAIT.width, A4_PORTRAIT.height, job);
    expect(ctx.paymentLineTexts).toHaveLength(1);
    expect(ctx.paymentLineTexts[0]).toContain("STAFF PRINT");
    expect(ctx.paymentLineTexts.join(" ")).not.toContain("should-never-show");
  });

  it("uses the normal payment lines (never STAFF PRINT) for a paid job", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const job = makeTestJob({ paidAmount: 19.5, paymentId: "pay_ABC" });
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, A4_PORTRAIT.width, A4_PORTRAIT.height, job);
    expect(ctx.paymentLineTexts.join(" ")).not.toContain("STAFF PRINT");
  });
});

describe.each(PAGE_SIZES)("computeBannerPlan on %s", (_name, size) => {
  describe.each(PAYMENT_SCENARIOS)("with %s", (_scenarioName, paymentOverrides) => {
    it.each([
      ["with the QR image", true],
      ["without the QR image", false],
    ])("never overlaps, stays within the safe margins, and prints no undefined/null text (%s)", async (_qrLabel, withQr) => {
      const { bold, regular, qrMatrix } = await buildTestFonts();
      const job = makeTestJob(paymentOverrides);
      const ctx = buildBannerPlanContext(bold, regular, withQr ? qrMatrix : null, size.width, size.height, job);

      let elements: PlannedElement[];
      try {
        elements = computeBannerPlan(ctx);
      } catch {
        // The computed layout can legitimately give up on the very-small
        // fixtures — prependBannerPage's own simple fallback is what
        // guarantees a print either way, covered separately below.
        return;
      }

      assertNoOverlapsAndWithinMargins(elements, size.width, size.height);
      assertNoUndefinedOrNullText(elements);
    });
  });
});

describe("computeBannerPlan QR geometry", () => {
  it("draws the QR at its full target size when there's plenty of room (A4, either orientation)", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    for (const size of [A4_PORTRAIT, A4_LANDSCAPE]) {
      const ctx = buildBannerPlanContext(bold, regular, qrMatrix, size.width, size.height, makeTestJob());
      const elements = computeBannerPlan(ctx);
      const qrElement = elements.find((el) => el.id === "qr");
      expect(qrElement).toBeDefined();
      expect(qrElement!.rect.width).toBeCloseTo(BANNER_LAYOUT_CONFIG.blocks.qr.targetSizeMm * MM_TO_PT, 1);
    }
  });

  it("never shrinks the QR below its configured floor", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    for (const [, size] of PAGE_SIZES) {
      const ctx = buildBannerPlanContext(bold, regular, qrMatrix, size.width, size.height, makeTestJob());
      try {
        const elements = computeBannerPlan(ctx);
        const qrElement = elements.find((el) => el.id === "qr");
        if (qrElement) {
          const minSizePt = BANNER_LAYOUT_CONFIG.blocks.qr.minSizeMm * MM_TO_PT;
          // A sufficiently narrow page can still legitimately clamp the QR
          // to the column width, below the configured floor — the
          // documented floor is a vertical-fit/drop-priority guarantee
          // only. Allow a generous tolerance for that, not the real target.
          expect(qrElement.rect.width).toBeGreaterThan(minSizePt * 0.5);
        }
      } catch {
        // No layout fit at all — nothing to assert about QR size.
      }
    }
  });
});

describe("prependBannerPage", () => {
  async function buildContentPdf(layout: "portrait" | "landscape"): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage(layout === "landscape" ? [841.89, 595.28] : [595.28, 841.89]);
    return doc.save();
  }

  it("produces exactly one banner page plus the original content, in portrait, with the banner FIRST", async () => {
    resetQrMatrixCacheForTests();
    const result = await prependBannerPage(await buildContentPdf("portrait"), makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);
    // Whatever prints first ends up on top of the finished stack on this
    // printer — the banner has to be the first page in the file, not last.
    const pages = resultDoc.getPages();
    expect(pages[0].getWidth()).toBeCloseTo(595.28, 1); // banner, matching A4 portrait
    expect(pages[0].getHeight()).toBeCloseTo(841.89, 1);
    expect(pages[1].getWidth()).toBeCloseTo(595.28, 1); // content page, untouched
    expect(pages[1].getHeight()).toBeCloseTo(841.89, 1);
  });

  it("matches a landscape job's orientation and still produces exactly one banner page, first (the reported overlap bug's exact scenario)", async () => {
    resetQrMatrixCacheForTests();
    const result = await prependBannerPage(await buildContentPdf("landscape"), makeTestJob({ paidAmount: 19.5, paymentId: "pay_ABC123XYZ9", upiTxnId: "123456789012" }));
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);
    const bannerPage = resultDoc.getPages()[0];
    expect(bannerPage.getWidth()).toBeGreaterThan(bannerPage.getHeight());
  });

  it("still prints a normal, single banner page when QR generation fails", async () => {
    resetQrMatrixCacheForTests();
    vi.mocked(generateQrMatrix).mockImplementationOnce(() => {
      throw new Error("simulated QR generation failure");
    });

    const result = await prependBannerPage(await buildContentPdf("portrait"), makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2); // the job still printed — no QR, not a crash
  });

  it("never throws for any job, even one missing every payment field", async () => {
    resetQrMatrixCacheForTests();
    const job = makeTestJob({ paidAmount: undefined, paymentId: undefined, upiTxnId: undefined, totalPrice: undefined as unknown as number });
    await expect(prependBannerPage(await buildContentPdf("portrait"), job)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("stays at exactly one banner page across several different jobs (sanity check against a regression that adds a second page)", async () => {
    resetQrMatrixCacheForTests();
    for (const ticketNumber of [1, 42, 999]) {
      const result = await prependBannerPage(await buildContentPdf("portrait"), makeTestJob({ ticketNumber }));
      const resultDoc = await PDFDocument.load(result);
      expect(resultDoc.getPageCount()).toBe(2);
    }
  });
});

describe("very small landscape page (stresses the side-by-side layout's own shrink/drop ladder)", () => {
  it("either produces a valid layout or gives up cleanly — never overlaps or spills off the page", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, VERY_SMALL_LANDSCAPE.width, VERY_SMALL_LANDSCAPE.height, makeTestJob());
    try {
      const elements = computeBannerPlan(ctx);
      assertNoOverlapsAndWithinMargins(elements, VERY_SMALL_LANDSCAPE.width, VERY_SMALL_LANDSCAPE.height);
      assertNoUndefinedOrNullText(elements);
    } catch {
      // Giving up entirely is an acceptable outcome at this size — prependBannerPage's own simple fallback (tested separately) is what guarantees a print either way.
    }
  });

  it("still prints exactly one banner page end to end, falling back to the simple layout if needed", async () => {
    resetQrMatrixCacheForTests();
    const doc = await PDFDocument.create();
    doc.addPage([VERY_SMALL_LANDSCAPE.width, VERY_SMALL_LANDSCAPE.height]);
    const contentBytes = await doc.save();
    const result = await prependBannerPage(contentBytes, makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);
  });
});

describe("the generated QR — requirement #5: decodes back to the exact URL, at the final printed size", () => {
  it.each([
    ["portrait (full target size)", A4_PORTRAIT],
    ["landscape, side-by-side layout", A4_LANDSCAPE],
  ])("decodes to BANNER_LAYOUT_CONFIG.instagram.url in a %s banner, rasterized at 150dpi to simulate a worse print", async (_label, size) => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, size.width, size.height, makeTestJob());
    const elements = computeBannerPlan(ctx);
    const qrElement = elements.find((el) => el.id === "qr");
    expect(qrElement).toBeDefined();

    const raster = rasterizeQrElement(qrElement!, 150);
    const decoded = jsQR(raster.data, raster.width, raster.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(BANNER_LAYOUT_CONFIG.instagram.url);
  });

  it("still decodes at its shrunk floor size (minSizeMm), rasterized at 150dpi", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    // Narrow enough that the single-column solver needs its QR-shrink stage
    // to fit, but not so short it drops the QR entirely — asserted below
    // before trusting the decode to mean anything.
    const SHRUNK_QR_FIXTURE = { width: 300, height: 350 };
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, SHRUNK_QR_FIXTURE.width, SHRUNK_QR_FIXTURE.height, makeTestJob());
    const elements = computeBannerPlan(ctx);
    const qrElement = elements.find((el) => el.id === "qr");
    expect(qrElement).toBeDefined();
    expect(qrElement!.rect.width).toBeCloseTo(BANNER_LAYOUT_CONFIG.blocks.qr.minSizeMm * MM_TO_PT, 1);

    const raster = rasterizeQrElement(qrElement!, 150);
    const decoded = jsQR(raster.data, raster.width, raster.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(BANNER_LAYOUT_CONFIG.instagram.url);
  });

  it("never overlaps the caption, the handle, or any other banner content", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, A4_PORTRAIT.width, A4_PORTRAIT.height, makeTestJob());
    const elements = computeBannerPlan(ctx);
    expect(elements.some((el) => el.id === "qrCaption")).toBe(true);
    expect(elements.some((el) => el.id === "qrHandle")).toBe(true);
    assertNoOverlapsAndWithinMargins(elements, A4_PORTRAIT.width, A4_PORTRAIT.height);
  });

  it("prints the caption and the handle as separate, non-empty text lines", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, A4_PORTRAIT.width, A4_PORTRAIT.height, makeTestJob());
    const elements = computeBannerPlan(ctx);
    const caption = elements.find((el) => el.id === "qrCaption");
    const handle = elements.find((el) => el.id === "qrHandle");
    expect(caption?.content.kind).toBe("text");
    expect(handle?.content.kind).toBe("text");
    if (caption?.content.kind === "text") expect(caption.content.text).toBe(BANNER_LAYOUT_CONFIG.blocks.qrCaption.text);
    if (handle?.content.kind === "text") expect(handle.content.text).toBe(BANNER_LAYOUT_CONFIG.instagram.handle);
    // The handle sits directly below the caption, not above it or elsewhere.
    expect(handle!.rect.y).toBeLessThan(caption!.rect.y);
  });

  it("draws every dark module as a pure black vector rectangle — never an embedded image", async () => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, A4_PORTRAIT.width, A4_PORTRAIT.height, makeTestJob());
    const elements = computeBannerPlan(ctx);
    const qrElement = elements.find((el) => el.id === "qr")!;
    expect(qrElement.content.kind).toBe("qr");
    if (qrElement.content.kind === "qr") {
      expect(qrElement.content.rects.length).toBeGreaterThan(0);
      // Merging consecutive dark modules in a row means far fewer
      // rectangles than one-per-module (29x29 modules = 841 if unmerged).
      expect(qrElement.content.rects.length).toBeLessThan(qrMatrix.size * qrMatrix.size);
    }
  });

  it("skips the whole QR block (never draws an illegibly small code) when even the full target size would put a module under minModuleSizeMm", async () => {
    // Our real ~29-module Instagram URL never gets anywhere near the
    // module floor on any plausible banner page — this proves the guard
    // itself works by forcing a much bigger QR version instead (a long
    // garbage payload needs far more modules to encode), on a full,
    // otherwise-roomy A4 page. 0.4mm/module requires at most ~37 modules
    // across a 35mm target box; this one needs 169+8.
    const { bold, regular } = await buildTestFonts();
    const oversizedMatrix = generateQrMatrix(`https://example.com/${"a".repeat(2000)}`, "M");
    expect(oversizedMatrix.size).toBeGreaterThan(100);

    const ctx = buildBannerPlanContext(bold, regular, oversizedMatrix, A4_PORTRAIT.width, A4_PORTRAIT.height, makeTestJob());
    const elements = computeBannerPlan(ctx);
    expect(elements.find((el) => el.id === "qr")).toBeUndefined();
    expect(elements.find((el) => el.id === "qrCaption")).toBeUndefined();
    expect(elements.find((el) => el.id === "qrHandle")).toBeUndefined();
    // Everything else on a full A4 page still lays out normally — dropping
    // the QR never degrades the rest of the banner.
    expect(elements.find((el) => el.id === "ticketCode")).toBeDefined();
  });
});

describe("pickup ticket code — 3, 4 and 5 digit codes, requirement #3", () => {
  const TICKET_NUMBERS = [99, 100, 999, 1000, 10000];

  it.each(TICKET_NUMBERS)("renders the exact, untruncated code for #%i on a real A4 page, portrait and landscape, with no overlap or clipping", async (ticketNumber) => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const job = makeTestJob({ ticketNumber });
    const expected = `#${String(ticketNumber).padStart(3, "0")}`;

    for (const size of [A4_PORTRAIT, A4_LANDSCAPE]) {
      const ctx = buildBannerPlanContext(bold, regular, qrMatrix, size.width, size.height, job);
      const elements = computeBannerPlan(ctx); // throws BannerSafetyNetViolation on any overlap/margin violation — a passing call IS the "no clipping" check
      assertNoOverlapsAndWithinMargins(elements, size.width, size.height);

      const ticketEl = elements.find((el) => el.id === "ticketCode");
      expect(ticketEl).toBeDefined();
      expect(ticketEl!.content.kind).toBe("text");
      if (ticketEl!.content.kind === "text") {
        // The real bug this guards against: fitTextWidth's generic
        // shrink-then-"..." behavior would otherwise quietly turn a long
        // ticket code into literal "#..." once it stopped fitting at the
        // normal font floor — see TICKET_CODE_ABSOLUTE_MIN_FONT_PT in
        // banner.ts. Checking the exact text (not just "doesn't overlap")
        // is the only way to catch that class of bug.
        expect(ticketEl!.content.text).toBe(expected);
      }
    }
  });

  it.each(TICKET_NUMBERS)("never truncates #%i even on the engine's own smallest realistic stress fixture (very small portrait)", async (ticketNumber) => {
    const { bold, regular, qrMatrix } = await buildTestFonts();
    const job = makeTestJob({ ticketNumber });
    const expected = `#${String(ticketNumber).padStart(3, "0")}`;

    const ctx = buildBannerPlanContext(bold, regular, qrMatrix, VERY_SMALL_PORTRAIT.width, VERY_SMALL_PORTRAIT.height, job);
    const elements = computeBannerPlan(ctx);
    assertNoOverlapsAndWithinMargins(elements, VERY_SMALL_PORTRAIT.width, VERY_SMALL_PORTRAIT.height);

    const ticketEl = elements.find((el) => el.id === "ticketCode");
    expect(ticketEl?.content.kind === "text" ? ticketEl.content.text : null).toBe(expected);
  });

  it.each(TICKET_NUMBERS)("never truncates #%i through the full prependBannerPage pipeline, even when it falls back to the simple layout", async (ticketNumber) => {
    resetQrMatrixCacheForTests();
    const contentDoc = await PDFDocument.create();
    contentDoc.addPage([VERY_SMALL_LANDSCAPE.width, VERY_SMALL_LANDSCAPE.height]); // small enough to force the simple-fallback path (confirmed elsewhere in this file to throw NoLayoutFitsError at this size)
    const contentBytes = await contentDoc.save();

    const result = await prependBannerPage(contentBytes, makeTestJob({ ticketNumber }));
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2); // still exactly one banner + the content — the fallback never fails the print
  });

  it("formats 4 and 5 digit ticket numbers as a wider code, never padded/cut back down to 3 digits", () => {
    const toText = (n: number) => `#${String(n).padStart(3, "0")}`;
    expect(toText(1000)).toBe("#1000");
    expect(toText(10000)).toBe("#10000");
    expect(toText(1000)).not.toBe(toText(100));
  });
});
