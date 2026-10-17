import { describe, expect, it } from "vitest";
import type { PrintJobRecord } from "../store";
import { computeStackEstimate } from "./tray-estimate";

function job(copies: number, pagesPerSheet: 1 | 2 | 4, pageCount: number): PrintJobRecord {
  return {
    id: "job",
    status: "printed",
    fileName: "f.pdf",
    selectedPages: Array.from({ length: pageCount }, (_, i) => i + 1),
    settings: { copies, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet },
    totalPrice: 2,
    phoneNumber: "",
    notifyOptIn: false,
    includeBannerPage: true,
    contentHash: "hash",
    provider: "razorpay",
    providerOrderId: "order",
    pdfStoragePath: "f.pdf",
    kioskId: "oxway_01",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("computeStackEstimate", () => {
  it("empty tray: position 1, no sheets ahead", () => {
    expect(computeStackEstimate([])).toEqual({ stackPosition: 1, sheetsAhead: 0 });
  });

  it("counts jobs ahead as the stack position and sums their physical sheets", () => {
    const result = computeStackEstimate([job(1, 1, 3), job(2, 1, 2)]);
    expect(result.stackPosition).toBe(3);
    expect(result.sheetsAhead).toBe((3 + 1) + (4 + 1));
  });
});
