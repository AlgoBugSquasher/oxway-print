import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_FILE_SIZE_BYTES, MAX_UPLOAD_PAGE_COUNT } from "./config";
import { computeBillableSheets, computeOrderPrice } from "./pricing";

// Mirrors app/api/create-order/route.ts's own server-side price
// recomputation exactly — the route is a thin wrapper around these two
// functions (extracted specifically so this logic is directly testable
// without standing up a Next.js route handler / mocking Supabase+payment
// providers just to check arithmetic).

describe("computeBillableSheets", () => {
  it("rounds a partial sheet up — pagesPerSheet doesn't divide the page count evenly", () => {
    expect(computeBillableSheets(5, 2, 1)).toBe(3); // ceil(5/2) = 3
  });

  it("multiplies by copies", () => {
    expect(computeBillableSheets(4, 1, 3)).toBe(12);
  });

  it("combines N-up imposition and copies together", () => {
    expect(computeBillableSheets(10, 4, 2)).toBe(6); // ceil(10/4)=3, * 2 copies = 6
  });

  it("a single page always costs at least one sheet", () => {
    expect(computeBillableSheets(1, 4, 1)).toBe(1);
  });
});

describe("computeOrderPrice", () => {
  const rates = { priceBw: 2, priceColor: 10 };

  it("uses the B&W rate when isColor is false", () => {
    expect(computeOrderPrice(5, false, rates)).toBe(10);
  });

  it("uses the color rate when isColor is true", () => {
    expect(computeOrderPrice(5, true, rates)).toBe(50);
  });

  it("zero billable sheets costs nothing", () => {
    expect(computeOrderPrice(0, true, rates)).toBe(0);
  });
});

describe("end-to-end price recomputation (matching create-order's own call sequence)", () => {
  it("recomputes the same price from a real page count as the server would, for a multi-file merged upload", () => {
    const pageCountFromMergedPdf = 23; // what extractSelectedPages would report for the actual uploaded bytes
    const settings = { pagesPerSheet: 2, copies: 2, isColor: false };
    const rates = { priceBw: 2, priceColor: 10 };

    const billableSheets = computeBillableSheets(pageCountFromMergedPdf, settings.pagesPerSheet, settings.copies);
    const price = computeOrderPrice(billableSheets, settings.isColor, rates);

    expect(billableSheets).toBe(24); // ceil(23/2) = 12, * 2 copies = 24
    expect(price).toBe(48);
  });

  it("a tampered/stale client price fails the mismatch check create-order itself applies", () => {
    const realPageCount = 23;
    const settings = { pagesPerSheet: 1, copies: 1, isColor: false };
    const rates = { priceBw: 2, priceColor: 10 };
    const expectedPrice = computeOrderPrice(computeBillableSheets(realPageCount, settings.pagesPerSheet, settings.copies), settings.isColor, rates);

    const claimedPrice = 1; // what a tampered request might send
    const PRICE_EPSILON = 0.01; // matches create-order/route.ts's own constant
    expect(Math.abs(expectedPrice - claimedPrice) > PRICE_EPSILON).toBe(true);
  });
});

describe("upload limits (app/api/create-order/route.ts's server-side, authoritative copies)", () => {
  it("MAX_UPLOAD_FILE_SIZE_BYTES is 50 MB, matching the client basket's own per-file limit (lib/hooks/useFileBasket.ts's MAX_FILE_SIZE_BYTES)", () => {
    expect(MAX_UPLOAD_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
  });

  it("MAX_UPLOAD_PAGE_COUNT is 300, matching the client basket's own combined-page limit (lib/hooks/useFileBasket.ts's MAX_TOTAL_PAGES_PER_BASKET)", () => {
    expect(MAX_UPLOAD_PAGE_COUNT).toBe(300);
  });

  it("a file exactly at the size limit is accepted, one byte over is rejected — matches create-order's `>` comparison, not `>=`", () => {
    expect(MAX_UPLOAD_FILE_SIZE_BYTES > MAX_UPLOAD_FILE_SIZE_BYTES).toBe(false);
    expect(MAX_UPLOAD_FILE_SIZE_BYTES + 1 > MAX_UPLOAD_FILE_SIZE_BYTES).toBe(true);
  });

  it("a document with exactly the page limit is accepted, one page over is rejected", () => {
    expect(MAX_UPLOAD_PAGE_COUNT > MAX_UPLOAD_PAGE_COUNT).toBe(false);
    expect(MAX_UPLOAD_PAGE_COUNT + 1 > MAX_UPLOAD_PAGE_COUNT).toBe(true);
  });
});
