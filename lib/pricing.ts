export interface PricingRates {
  priceBw: number;
  priceColor: number;
}

/**
 * Billable sheets for a print job — the customer-facing, BILLED page count.
 * Never includes the mandatory pickup-ID banner (that's absorbed as a
 * business cost, not itemized — see app/api/create-order/route.ts). This is
 * a distinct count from lib/print/sheets.ts's physicalSheetsForJob, which
 * DOES include the banner and feeds the paper/toner supply counters, not
 * billing — the two intentionally diverge by exactly one sheet per job.
 */
export function computeBillableSheets(pageCount: number, pagesPerSheet: number, copies: number): number {
  return Math.ceil(pageCount / pagesPerSheet) * copies;
}

export function computeOrderPrice(billableSheets: number, isColor: boolean, rates: PricingRates): number {
  return billableSheets * (isColor ? rates.priceColor : rates.priceBw);
}
