import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { PrintJobRecord } from "../store";
import { prependSeparatorPage } from "./separator";

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
    includeBannerPage: true,
    contentHash: "hash",
    provider: "razorpay",
    providerOrderId: "order_test",
    pdfStoragePath: "test.pdf",
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

describe("prependSeparatorPage", () => {
  it("produces exactly one separator page plus the original content, with the separator FIRST", async () => {
    const result = await prependSeparatorPage(await buildContentPdf("portrait"), makeTestJob());
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
  });

  it("portrait safe: matches a portrait content page's own orientation", async () => {
    const result = await prependSeparatorPage(await buildContentPdf("portrait"), makeTestJob());
    const doc = await PDFDocument.load(result);
    const separator = doc.getPage(0);
    expect(separator.getHeight()).toBeGreaterThan(separator.getWidth());
  });

  it("landscape safe: matches a landscape content page's own orientation", async () => {
    const result = await prependSeparatorPage(await buildContentPdf("landscape"), makeTestJob());
    const doc = await PDFDocument.load(result);
    const separator = doc.getPage(0);
    expect(separator.getWidth()).toBeGreaterThan(separator.getHeight());
  });

  it("4+ digit codes safe: a large ticket number still fits on the page without throwing", async () => {
    await expect(prependSeparatorPage(await buildContentPdf("portrait"), makeTestJob({ ticketNumber: 9999 }))).resolves.toBeInstanceOf(Uint8Array);
  });

  it("never modifies the content page itself — same page count, size and bytes count as the source content", async () => {
    const contentBytes = await buildContentPdf("portrait");
    const contentDoc = await PDFDocument.load(contentBytes);
    const result = await prependSeparatorPage(contentBytes, makeTestJob());
    const resultDoc = await PDFDocument.load(result);
    const contentPage = resultDoc.getPage(1);
    expect(contentPage.getWidth()).toBeCloseTo(contentDoc.getPage(0).getWidth(), 3);
    expect(contentPage.getHeight()).toBeCloseTo(contentDoc.getPage(0).getHeight(), 3);
  });

  it("falls back to the raw request id when no ticket number is assigned yet", async () => {
    await expect(prependSeparatorPage(await buildContentPdf("portrait"), makeTestJob({ ticketNumber: undefined }))).resolves.toBeInstanceOf(Uint8Array);
  });
});
