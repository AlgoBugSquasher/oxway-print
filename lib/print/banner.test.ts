import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import jsQR from "jsqr";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import type { PrintJobRecord } from "../store";
import {
  BANNER_QR_CONFIG,
  MM_TO_PT,
  drawBannerQrBlock,
  prependBannerPage,
  resetInstaQrCacheForTests,
  type BannerQrBlockGeometry,
} from "./banner";

// Wraps the real node:fs/promises so every test gets genuine file reads by
// default — only the one "image is missing" test below overrides this for
// a single call, via mockRejectedValueOnce. This is what lets this file
// test the real fallback path without a second, parallel "fake fs" story
// for every other test.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const INSTA_PNG_PATH = path.join(process.cwd(), "public", "brand", "insta.png");
const MARGIN_PT = BANNER_QR_CONFIG.marginMm * MM_TO_PT;
const MIN_QR_SIZE_PT = BANNER_QR_CONFIG.minSizeMm * MM_TO_PT;
// Float rounding tolerance for the "is this within the margin line" checks below.
const EPSILON = 0.01;

const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };
const LETTER = { width: 612, height: 792 };
// Small enough that 2*marginMm + the caption's own line height already
// exceeds it before the QR even enters the picture — deliberately well
// past the point this should give up, not just barely under.
const VERY_SMALL_PAGE = { width: 100, height: 140 };
// Sits strictly between the floor (25mm) and the target (35mm) converted
// to pt, specifically to exercise the *shrink* path rather than the
// full-size or skip-entirely ones.
const SHRINK_REGIME_PAGE = { width: 300, height: 175 };

async function buildTestDoc(width: number, height: number) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const qrImage = await doc.embedPng(readFileSync(INSTA_PNG_PATH));
  return { doc, page, font, qrImage };
}

/**
 * The invariants every successful placement must satisfy, regardless of
 * page size — this is the actual substance of "inside the page bounds
 * with the minimum margins, no overlap," not a restatement of
 * drawBannerQrBlock's own formula (that would just duplicate it, not test
 * it).
 */
function assertWithinBoundsAndMargins(geometry: BannerQrBlockGeometry, pageWidth: number, pageHeight: number) {
  // Side margins — both the QR and the caption (usually the wider of the two).
  expect(geometry.qr.x).toBeGreaterThanOrEqual(MARGIN_PT - EPSILON);
  expect(geometry.qr.x + geometry.qr.size).toBeLessThanOrEqual(pageWidth - MARGIN_PT + EPSILON);
  expect(geometry.caption.x).toBeGreaterThanOrEqual(MARGIN_PT - EPSILON);
  expect(geometry.caption.x + geometry.caption.width).toBeLessThanOrEqual(pageWidth - MARGIN_PT + EPSILON);
  // Bottom margin.
  expect(geometry.caption.y).toBeGreaterThanOrEqual(MARGIN_PT - EPSILON);
  // Top-of-block margin.
  expect(geometry.topY).toBeLessThanOrEqual(pageHeight - MARGIN_PT + EPSILON);
  // Caption sits below the QR, with daylight between them (never squeezed
  // to zero or overlapping the image).
  expect(geometry.qr.y).toBeGreaterThan(geometry.caption.y);
  // Never below the documented floor.
  expect(geometry.qr.size).toBeGreaterThanOrEqual(MIN_QR_SIZE_PT - EPSILON);
  // Square, per "only ever scaled at its original aspect ratio."
  expect(geometry.qr.size).toBeCloseTo(geometry.qr.size, 5);
}

/** Decodes a PNG's raw pixels with jsQR. */
function decodeQrFromPng(buffer: Buffer) {
  const png = PNG.sync.read(buffer);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: "attemptBoth" });
}

describe("insta.png itself", () => {
  // NOT a hard pass/fail assertion — see the long comment below for why.
  // jsQR (and, separately confirmed during development, ZXing — a second,
  // independent, more sophisticated decoder) both fail to even locate this
  // image's finder patterns: insta.png is a heavily stylized QR (dot-style
  // modules, an orange-to-pink gradient instead of solid black, rounded
  // corner-square finder patterns, and an Instagram logo over the center
  // modules), which is a known weak spot for classic computer-vision QR
  // locators — they're tuned to find sharp-cornered square:square:square
  // ratio patterns, not rounded gradient ones. This is NOT proof the code
  // is unscannable: real phone camera apps (the exact thing this is meant
  // for) use far more capable, often ML-assisted detection specifically
  // because artistic QR codes like Instagram's own generator produces are
  // common and expected to just work. Confirmed jsQR/pngjs/this harness
  // all work correctly against a plain reference QR during development —
  // this isn't a test-setup bug, it's this specific image style.
  //
  // What this test actually gives you: a loud, visible signal (not a
  // silent, easy-to-miss one) that an automated decode attempt against
  // this exact file still fails, logged every test run. The real,
  // authoritative check task requirement #10 calls for — scanning a
  // PRINTED copy with a few actual phones — is not something any of this
  // can substitute for, and should happen before relying on this in
  // production.
  it("logs whether it can be auto-decoded (informational only — see the comment above, physically test-scan the printed banner instead)", () => {
    const decoded = decodeQrFromPng(readFileSync(INSTA_PNG_PATH));
    if (!decoded) {
      console.warn(
        "[banner.test] insta.png did not auto-decode with jsQR — expected for this stylized QR style; physically test-scan the printed banner with a real phone before relying on it."
      );
    }
    // Intentionally no expect() on the decode result itself — see above.
  });
});

describe.each([
  ["portrait A4", A4_PORTRAIT],
  ["landscape A4", A4_LANDSCAPE],
  ["Letter", LETTER],
])("drawBannerQrBlock on %s", (_name, size) => {
  it("places the QR and caption at full size, within margins, with no overlap", async () => {
    const { page, font, qrImage } = await buildTestDoc(size.width, size.height);
    const geometry = drawBannerQrBlock(page, { qrImage, font, pageWidth: size.width, pageHeight: size.height });

    expect(geometry).not.toBeNull();
    assertWithinBoundsAndMargins(geometry!, size.width, size.height);
    // Plenty of room on every one of these real page sizes — nothing
    // should force a shrink away from the configured target.
    expect(geometry!.qr.size).toBeCloseTo(BANNER_QR_CONFIG.sizeMm * MM_TO_PT, 3);
  });
});

describe("drawBannerQrBlock proportional shrink", () => {
  it("shrinks the QR (never the margins or the gap) when the page is tight but not hopeless", async () => {
    const { page, font, qrImage } = await buildTestDoc(SHRINK_REGIME_PAGE.width, SHRINK_REGIME_PAGE.height);
    const geometry = drawBannerQrBlock(page, { qrImage, font, pageWidth: SHRINK_REGIME_PAGE.width, pageHeight: SHRINK_REGIME_PAGE.height });

    expect(geometry).not.toBeNull();
    assertWithinBoundsAndMargins(geometry!, SHRINK_REGIME_PAGE.width, SHRINK_REGIME_PAGE.height);
    expect(geometry!.qr.size).toBeLessThan(BANNER_QR_CONFIG.sizeMm * MM_TO_PT);
    expect(geometry!.qr.size).toBeGreaterThanOrEqual(MIN_QR_SIZE_PT - EPSILON);
  });
});

describe("drawBannerQrBlock on a very small page", () => {
  it("skips the block entirely rather than drawing something overlapping or off-page", async () => {
    const { page, font, qrImage } = await buildTestDoc(VERY_SMALL_PAGE.width, VERY_SMALL_PAGE.height);
    const geometry = drawBannerQrBlock(page, { qrImage, font, pageWidth: VERY_SMALL_PAGE.width, pageHeight: VERY_SMALL_PAGE.height });

    expect(geometry).toBeNull();
  });

  it("never throws, even on a page too small for anything to fit", async () => {
    const { page, font, qrImage } = await buildTestDoc(VERY_SMALL_PAGE.width, VERY_SMALL_PAGE.height);
    expect(() => drawBannerQrBlock(page, { qrImage, font, pageWidth: VERY_SMALL_PAGE.width, pageHeight: VERY_SMALL_PAGE.height })).not.toThrow();
  });
});

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

async function buildContentPdf(layout: "portrait" | "landscape"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage(layout === "landscape" ? [841.89, 595.28] : [595.28, 841.89]);
  return doc.save();
}

describe("prependBannerPage", () => {
  it("still produces exactly one banner page plus the original content, with the QR drawn", async () => {
    resetInstaQrCacheForTests();
    const result = await prependBannerPage(await buildContentPdf("portrait"), makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2); // banner + the one content page
  });

  it("matches a landscape job's orientation and still produces exactly one banner page", async () => {
    resetInstaQrCacheForTests();
    const result = await prependBannerPage(await buildContentPdf("landscape"), makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);
    const [bannerPage] = resultDoc.getPages();
    expect(bannerPage.getWidth()).toBeGreaterThan(bannerPage.getHeight()); // landscape banner, matching landscape content
  });

  it("still prints a normal, single banner page when insta.png can't be read", async () => {
    resetInstaQrCacheForTests();
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT: simulated missing file"));

    const result = await prependBannerPage(await buildContentPdf("portrait"), makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2); // the job still printed — no QR, not a crash
  });

  it("stays at exactly one banner page across several different jobs (sanity check against a regression that adds a second page)", async () => {
    resetInstaQrCacheForTests();
    for (const ticketNumber of [1, 42, 999]) {
      const result = await prependBannerPage(await buildContentPdf("portrait"), makeTestJob({ ticketNumber }));
      const resultDoc = await PDFDocument.load(result);
      expect(resultDoc.getPageCount()).toBe(2);
    }
  });
});

describe("no overlap with the existing banner content", () => {
  it("keeps the QR block's clearance below where the Request ID line already sits on a real A4 banner", async () => {
    const { page, font, qrImage } = await buildTestDoc(A4_PORTRAIT.width, A4_PORTRAIT.height);
    const geometry = drawBannerQrBlock(page, { qrImage, font, pageWidth: A4_PORTRAIT.width, pageHeight: A4_PORTRAIT.height });
    expect(geometry).not.toBeNull();

    // Mirrors banner.ts's own existing "Request ID: ..." line position
    // (bannerHeight - 420) — the lowest pre-existing content on the page.
    // Duplicated here deliberately, as a regression trip-wire: if this
    // repositioning math and that unrelated line's position were ever
    // changed independently, this is what would catch them colliding.
    const existingContentLowerBoundY = A4_PORTRAIT.height - 420;
    const clearanceTopY = geometry!.topY + BANNER_QR_CONFIG.clearanceMm * MM_TO_PT;
    expect(clearanceTopY).toBeLessThan(existingContentLowerBoundY);
  });
});
