import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PrintJobRecord } from "../store";
import { appendBannerPage, resetInstaQrCacheForTests } from "./banner";
import { expandCopies } from "./pdf";

// Exactly the two-step pipeline print-agent/index.ts runs for every job:
// expandCopies (bakes N copies of the content into one PDF, collated) then
// appendBannerPage (adds the single pickup-ID page at the very end). These
// tests exercise that exact composition, not either function in isolation
// — isolated coverage for each already lives in pdf.test.ts and
// banner.test.ts respectively.

function makeTestJob(copies: number): PrintJobRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "paid",
    fileName: "test.pdf",
    selectedPages: [1],
    settings: { copies, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
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
    ticketNumber: 7,
    ticketDate: new Date().toISOString().slice(0, 10),
  };
}

/**
 * A content PDF whose pages each have a distinct, identifiable height
 * (401, 402, 403, ...pt — comfortably different from the ~842pt A4 portrait
 * banner page and from each other) so page order and repetition can be
 * verified by geometry alone, without needing to decode drawn content.
 */
async function buildContentPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    doc.addPage([300, 401 + i]);
  }
  return doc.save();
}

describe.each([
  ["a single-page document", 1],
  ["a multi-page document", 3],
])("print assembly for %s", (_label, contentPageCount: number) => {
  describe.each([1, 2, 3])("with %d cop(y/ies)", (copies) => {
    it("prints content first (each copy in its original 1..N order), then the banner last, exactly once", async () => {
      resetInstaQrCacheForTests();

      const contentBytes = await buildContentPdf(contentPageCount);
      const expanded = await expandCopies(contentBytes, copies);
      const result = await appendBannerPage(expanded, makeTestJob(copies));
      const resultDoc = await PDFDocument.load(result);
      const pages = resultDoc.getPages();

      // copies * contentPageCount content pages, plus exactly one banner page.
      expect(pages.length).toBe(copies * contentPageCount + 1);

      // Content pages come first, each copy repeating the same 1..N order
      // — never interleaved (page-1-of-every-copy then page-2-of-every-copy).
      const expectedContentHeights = Array.from({ length: copies }).flatMap(() =>
        Array.from({ length: contentPageCount }, (_, i) => 401 + i)
      );
      const actualContentHeights = pages.slice(0, -1).map((page) => page.getHeight());
      expect(actualContentHeights).toEqual(expectedContentHeights);

      // The banner is the very last page — this printer outputs face-down,
      // so the last page printed ends up on top of the finished stack —
      // and its height is never mistaken for one of the content pages'
      // own distinct, much smaller heights (A4 portrait is ~841.89pt).
      const bannerPage = pages.at(-1)!;
      expect(bannerPage.getHeight()).toBeGreaterThan(800);
      expect(actualContentHeights).not.toContain(bannerPage.getHeight());

      // Exactly one page at banner-ish height — never one per copy.
      const bannerLikePages = pages.filter((page) => page.getHeight() > 800);
      expect(bannerLikePages).toHaveLength(1);
    });
  });
});
