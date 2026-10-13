import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type Color, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { shortRequestId } from "../request-id";
import type { PrintJobRecord } from "../store";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/** 1 mm in PDF points — pdf-lib (and PDF itself) only ever works in points. */
export const MM_TO_PT = 72 / 25.4;

/**
 * Every size, gap, floor, label and drop priority the banner builder uses
 * lives here — nothing in the layout engine below should ever need a number
 * that isn't read from here (or from the page's own actual dimensions).
 *
 * Each text block carries its own `gapAfterMm` (the gap between it and
 * whatever block follows it) so the visual rhythm stays close to the
 * original hand-tuned banner — a bigger gap after the ticket code than
 * after the small Request ID line, for instance — while still being fully
 * computed and config-driven rather than hand-positioned.
 */
export const BANNER_LAYOUT_CONFIG = {
  marginMm: 12,
  qrImagePathSegments: ["public", "brand", "insta.png"],
  /** Gap between the two side-by-side columns in landscape mode. */
  sideBySideColumnGapMm: 10,
  /** Gap between the two-column content and the full-width OXWAY footer in side-by-side mode. */
  sideBySideFooterGapMm: { normalMm: 8, minMm: 4 },
  blocks: {
    pickupLabel: {
      text: "PICKUP ID",
      font: { normalPt: 24, minPt: 16 },
      color: rgb(0.29, 0.33, 0.41),
      gapAfterMm: { normalMm: 6, minMm: 3 },
    },
    ticketCode: {
      font: { normalPt: 90, minPt: 48 },
      color: rgb(0.15, 0.39, 0.92),
      gapAfterMm: { normalMm: 10, minMm: 4 },
    },
    detailLine: {
      font: { normalPt: 13, minPt: 10 },
      color: rgb(0.45, 0.5, 0.57),
      gapAfterMm: { normalMm: 3, minMm: 1.5 },
    },
    requestIdLine: {
      font: { normalPt: 11, minPt: 9 },
      color: rgb(0.65, 0.68, 0.72),
      gapAfterMm: { normalMm: 8, minMm: 4 },
    },
    paymentLines: {
      font: { normalPt: 11, minPt: 9 },
      color: rgb(0.65, 0.68, 0.72),
      lineGapMm: 2,
      gapAfterMm: { normalMm: 8, minMm: 4 },
    },
    qr: {
      targetSizeMm: 35,
      /** Below this, a camera can no longer reliably decode the code, so the whole block is dropped instead of shrinking further. */
      minSizeMm: 25,
      gapAfterMm: { normalMm: 3, minMm: 2 },
    },
    qrCaption: {
      text: "Scan to follow us on Instagram",
      font: { normalPt: 10.5, minPt: 7 },
      color: rgb(0.2, 0.2, 0.2),
      gapAfterMm: { normalMm: 8, minMm: 4 },
    },
    oxway: {
      text: "OXWAY",
      font: { normalPt: 16, minPt: 12 },
      color: rgb(0.15, 0.39, 0.92),
    },
  },
  labels: {
    requestIdPrefix: "Request ID: ",
    totalPaidPrefix: "Total paid: ",
    /** Printed instead of the ₹ glyph when the embedded font can't encode it. */
    rupeeFallback: "Rs. ",
    upiTxnPrefix: "UPI Txn ID: ",
    paymentIdPrefix: "Payment ID: ",
  },
  /** Order droppable blocks are removed in when nothing else makes the layout fit. Every other block (pickup label, ticket code, date/time, Request ID) is never dropped. */
  dropOrder: ["oxway", "qrCaption", "qr", "paymentLines"] as const,
} as const;

const RUPEE_GLYPH = "₹";
/** Float-rounding tolerance for the margin/overlap safety checks below. */
const EPS = 0.01;

// ----------------------------------------------------------------------------
// Low-level geometry
// ----------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width - EPS && a.x + a.width > b.x + EPS && a.y < b.y + b.height - EPS && a.y + a.height > b.y + EPS;
}

type PlannedContent =
  | { kind: "text"; text: string; font: PDFFont; size: number; color: Color }
  | { kind: "image"; image: PDFImage };

export interface PlannedElement {
  id: string;
  rect: Rect;
  content: PlannedContent;
}

/**
 * Thrown when a computed layout WAS produced but fails the overlap/margin
 * safety net — i.e. a real bug in the solver, not an expected "page too
 * small" outcome (see NoLayoutFitsError for that). Caught in
 * appendBannerPage, which falls back to the simple layout — except in
 * tests, which let it propagate, so a real layout bug shows up as a
 * failing test rather than a quietly-degraded banner. Exported so tests can
 * identify this specific failure mode rather than any unrelated error.
 */
export class BannerSafetyNetViolation extends Error {}

/** Thrown when no (drop level x shrink stage) combination fits at all — an expected outcome on a genuinely tiny page, not a bug. Always falls back silently, in every environment including tests. */
export class NoLayoutFitsError extends Error {}

function validateElements(elements: PlannedElement[], pageWidth: number, pageHeight: number, marginPt: number): string | null {
  for (const el of elements) {
    const r = el.rect;
    if (r.x < marginPt - EPS || r.y < marginPt - EPS || r.x + r.width > pageWidth - marginPt + EPS || r.y + r.height > pageHeight - marginPt + EPS) {
      return `"${el.id}" falls outside the ${BANNER_LAYOUT_CONFIG.marginMm}mm safe margin`;
    }
  }
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      if (rectsOverlap(elements[i].rect, elements[j].rect)) {
        return `"${elements[i].id}" overlaps "${elements[j].id}"`;
      }
    }
  }
  return null;
}

function safeWidthOfTextAtSize(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return Infinity;
  }
}

function fontCanEncode(font: PDFFont, text: string): boolean {
  try {
    font.widthOfTextAtSize(text, 10);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shrinks `text`'s font size (down to `minSize`) and, if it still doesn't
 * fit, truncates it with "..." — so a long value (a payment id, say) on a
 * narrow page always ends up within `maxWidth`, never spilling off the page.
 */
function fitTextWidth(font: PDFFont, text: string, startSize: number, minSize: number, maxWidth: number): { text: string; size: number; width: number } {
  let size = startSize;
  let width = safeWidthOfTextAtSize(font, text, size);
  while (width > maxWidth && size > minSize) {
    size = Math.max(size - 0.5, minSize);
    width = safeWidthOfTextAtSize(font, text, size);
  }

  let finalText = text;
  if (width > maxWidth) {
    let base = text;
    while (base.length > 1 && safeWidthOfTextAtSize(font, `${base.trimEnd()}...`, size) > maxWidth) {
      base = base.slice(0, -1);
    }
    finalText = `${base.trimEnd()}...`;
    width = safeWidthOfTextAtSize(font, finalText, size);
  }

  return { text: finalText, size, width };
}

// ----------------------------------------------------------------------------
// Blocks — the unit the layout solver stacks, shrinks and drops
// ----------------------------------------------------------------------------

interface MeasuredBlock {
  id: string;
  height: number;
  /** Gap between this block's bottom and the next block's top — 0 for whatever block ends up last. */
  gapAfterPt: number;
  /** Draws the block so its top edge sits at `topY` (PDF points, bottom-up axis). Returns the rect(s) actually occupied. */
  build: (topY: number) => PlannedElement[];
}

function makeTextBlock(
  id: string,
  text: string,
  font: PDFFont,
  sizing: { normalPt: number; minPt: number },
  color: Color,
  columnLeft: number,
  columnWidth: number,
  fontsShrunk: boolean,
  gapAfterPt: number
): MeasuredBlock {
  const startSize = fontsShrunk ? sizing.minPt : sizing.normalPt;
  const fitted = fitTextWidth(font, text, startSize, sizing.minPt, columnWidth);
  const height = font.heightAtSize(fitted.size);
  const x = columnLeft + (columnWidth - fitted.width) / 2;
  return {
    id,
    height,
    gapAfterPt,
    build(topY: number): PlannedElement[] {
      return [{ id, rect: { x, y: topY - height, width: fitted.width, height }, content: { kind: "text", text: fitted.text, font, size: fitted.size, color } }];
    },
  };
}

function makeQrImageBlock(qrImage: PDFImage, sizePt: number, columnLeft: number, columnWidth: number, gapAfterPt: number): MeasuredBlock {
  const x = columnLeft + (columnWidth - sizePt) / 2;
  return {
    id: "qr",
    height: sizePt,
    gapAfterPt,
    build(topY: number): PlannedElement[] {
      return [{ id: "qr", rect: { x, y: topY - sizePt, width: sizePt, height: sizePt }, content: { kind: "image", image: qrImage } }];
    },
  };
}

function makePaymentLinesBlock(
  texts: string[],
  font: PDFFont,
  sizing: { normalPt: number; minPt: number },
  color: Color,
  columnLeft: number,
  columnWidth: number,
  fontsShrunk: boolean,
  lineGapMm: number,
  gapAfterPt: number
): MeasuredBlock {
  const startSize = fontsShrunk ? sizing.minPt : sizing.normalPt;
  const fittedLines = texts.map((t) => fitTextWidth(font, t, startSize, sizing.minPt, columnWidth));
  const heights = fittedLines.map((f) => font.heightAtSize(f.size));
  const lineGapPt = lineGapMm * MM_TO_PT;
  const height = heights.reduce((sum, h) => sum + h, 0) + lineGapPt * (fittedLines.length - 1);

  return {
    id: "paymentLines",
    height,
    gapAfterPt,
    build(topY: number): PlannedElement[] {
      let y = topY;
      const out: PlannedElement[] = [];
      fittedLines.forEach((fitted, i) => {
        const lineHeight = heights[i];
        const x = columnLeft + (columnWidth - fitted.width) / 2;
        out.push({ id: `paymentLine${i}`, rect: { x, y: y - lineHeight, width: fitted.width, height: lineHeight }, content: { kind: "text", text: fitted.text, font, size: fitted.size, color } });
        y -= lineHeight + lineGapPt;
      });
      return out;
    },
  };
}

function totalStackHeight(blocks: MeasuredBlock[]): number {
  return blocks.reduce((sum, b, i) => sum + b.height + (i < blocks.length - 1 ? b.gapAfterPt : 0), 0);
}

function placeBlocks(blocks: MeasuredBlock[], topStartY: number): PlannedElement[] {
  let y = topStartY;
  const elements: PlannedElement[] = [];
  for (const block of blocks) {
    elements.push(...block.build(y));
    y -= block.height + block.gapAfterPt;
  }
  return elements;
}

// ----------------------------------------------------------------------------
// The shrink-then-drop solver
// ----------------------------------------------------------------------------

interface ShrinkState {
  gapShrunk: boolean;
  qrShrunk: boolean;
  fontsShrunk: boolean;
}

/** Tried in order: normal -> gaps at their minimum -> QR at its floor size too -> fonts at their floor too. The first one whose resulting stack fits wins. */
const SHRINK_STAGES: ShrinkState[] = [
  { gapShrunk: false, qrShrunk: false, fontsShrunk: false },
  { gapShrunk: true, qrShrunk: false, fontsShrunk: false },
  { gapShrunk: true, qrShrunk: true, fontsShrunk: false },
  { gapShrunk: true, qrShrunk: true, fontsShrunk: true },
];

function gapPt(cfg: { normalMm: number; minMm: number }, shrunk: boolean): number {
  return (shrunk ? cfg.minMm : cfg.normalMm) * MM_TO_PT;
}

/**
 * Tries every (drop level x shrink stage) combination, in that priority
 * order — full shrink ladder at drop level 0, then at drop level 1, etc —
 * and returns the first block set whose total height fits. `dropOrder` is
 * cumulative: drop level N drops the first N ids in the list.
 */
function solveBlocks(
  buildFn: (state: ShrinkState, dropped: Set<string>) => MeasuredBlock[],
  availableHeightPt: number,
  dropOrder: readonly string[]
): MeasuredBlock[] | null {
  const dropLevels: Set<string>[] = [new Set()];
  for (let i = 0; i < dropOrder.length; i++) {
    dropLevels.push(new Set(dropOrder.slice(0, i + 1)));
  }
  for (const dropped of dropLevels) {
    for (const state of SHRINK_STAGES) {
      const blocks = buildFn(state, dropped);
      if (totalStackHeight(blocks) <= availableHeightPt + EPS) return blocks;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Banner content — plan context and the two layout strategies
// ----------------------------------------------------------------------------

export interface BannerPlanContext {
  pageWidth: number;
  pageHeight: number;
  bold: PDFFont;
  regular: PDFFont;
  qrImage: PDFImage | null;
  pickupLabel: string;
  ticketCode: string;
  detailLine: string;
  requestIdLine: string;
  paymentLineTexts: string[];
  oxwayText: string;
}

function buildCoreAndQrBlocks(ctx: BannerPlanContext, state: ShrinkState, dropped: Set<string>, columnLeft: number, columnWidth: number, includeOxway: boolean): MeasuredBlock[] {
  const cfg = BANNER_LAYOUT_CONFIG.blocks;
  const blocks: MeasuredBlock[] = [];

  blocks.push(makeTextBlock("pickupLabel", ctx.pickupLabel, ctx.bold, cfg.pickupLabel.font, cfg.pickupLabel.color, columnLeft, columnWidth, state.fontsShrunk, gapPt(cfg.pickupLabel.gapAfterMm, state.gapShrunk)));
  blocks.push(makeTextBlock("ticketCode", ctx.ticketCode, ctx.bold, cfg.ticketCode.font, cfg.ticketCode.color, columnLeft, columnWidth, state.fontsShrunk, gapPt(cfg.ticketCode.gapAfterMm, state.gapShrunk)));
  blocks.push(makeTextBlock("detailLine", ctx.detailLine, ctx.regular, cfg.detailLine.font, cfg.detailLine.color, columnLeft, columnWidth, state.fontsShrunk, gapPt(cfg.detailLine.gapAfterMm, state.gapShrunk)));

  const hasPaymentLines = !dropped.has("paymentLines") && ctx.paymentLineTexts.length > 0;
  const requestIdGap = gapPt(cfg.requestIdLine.gapAfterMm, state.gapShrunk);
  blocks.push(makeTextBlock("requestIdLine", ctx.requestIdLine, ctx.regular, cfg.requestIdLine.font, cfg.requestIdLine.color, columnLeft, columnWidth, state.fontsShrunk, hasPaymentLines ? gapPt(cfg.paymentLines.gapAfterMm, state.gapShrunk) : requestIdGap));

  if (hasPaymentLines) {
    blocks.push(
      makePaymentLinesBlock(ctx.paymentLineTexts, ctx.regular, cfg.paymentLines.font, cfg.paymentLines.color, columnLeft, columnWidth, state.fontsShrunk, cfg.paymentLines.lineGapMm, gapPt(cfg.paymentLines.gapAfterMm, state.gapShrunk))
    );
  }

  if (ctx.qrImage && !dropped.has("qr")) {
    const qrSizePt = Math.min((state.qrShrunk ? cfg.qr.minSizeMm : cfg.qr.targetSizeMm) * MM_TO_PT, columnWidth);
    blocks.push(makeQrImageBlock(ctx.qrImage, qrSizePt, columnLeft, columnWidth, gapPt(cfg.qr.gapAfterMm, state.gapShrunk)));
    if (!dropped.has("qrCaption")) {
      blocks.push(makeTextBlock("qrCaption", cfg.qrCaption.text, ctx.regular, cfg.qrCaption.font, cfg.qrCaption.color, columnLeft, columnWidth, state.fontsShrunk, gapPt(cfg.qrCaption.gapAfterMm, state.gapShrunk)));
    }
  }

  if (includeOxway && !dropped.has("oxway")) {
    blocks.push(makeTextBlock("oxway", ctx.oxwayText, ctx.bold, cfg.oxway.font, cfg.oxway.color, columnLeft, columnWidth, state.fontsShrunk, 0));
  }

  return blocks;
}

function planSingleColumn(ctx: BannerPlanContext): PlannedElement[] | null {
  const marginPt = BANNER_LAYOUT_CONFIG.marginMm * MM_TO_PT;
  const columnLeft = marginPt;
  const columnWidth = ctx.pageWidth - 2 * marginPt;
  const availableHeightPt = ctx.pageHeight - 2 * marginPt;

  const blocks = solveBlocks((state, dropped) => buildCoreAndQrBlocks(ctx, state, dropped, columnLeft, columnWidth, true), availableHeightPt, BANNER_LAYOUT_CONFIG.dropOrder);
  if (!blocks) return null;

  const usedHeight = totalStackHeight(blocks);
  const topStartY = ctx.pageHeight - marginPt - Math.max(availableHeightPt - usedHeight, 0) / 2;
  return placeBlocks(blocks, topStartY);
}

/** Ticket code + details on the left, QR + caption on the right, OXWAY spanning the full width at the bottom — used in landscape, where a single column rarely has the vertical room this bug report was about. */
function planSideBySide(ctx: BannerPlanContext): PlannedElement[] | null {
  const cfg = BANNER_LAYOUT_CONFIG.blocks;
  const marginPt = BANNER_LAYOUT_CONFIG.marginMm * MM_TO_PT;
  const columnGapPt = BANNER_LAYOUT_CONFIG.sideBySideColumnGapMm * MM_TO_PT;
  const totalColumnsWidth = ctx.pageWidth - 2 * marginPt - columnGapPt;
  if (totalColumnsWidth <= 0) return null;

  const leftWidth = totalColumnsWidth * 0.55;
  const rightWidth = totalColumnsWidth - leftWidth;
  const leftLeft = marginPt;
  const rightLeft = marginPt + leftWidth + columnGapPt;

  // OXWAY is reserved first, at its normal size (always short, always fits width-wise) — leaves the rest of the height for the two columns.
  const oxwayBlock = makeTextBlock("oxway", ctx.oxwayText, ctx.bold, cfg.oxway.font, cfg.oxway.color, marginPt, ctx.pageWidth - 2 * marginPt, false, 0);
  const oxwayGapPt = gapPt(BANNER_LAYOUT_CONFIG.sideBySideFooterGapMm, false);
  const availableColumnHeightPt = ctx.pageHeight - 2 * marginPt - oxwayBlock.height - oxwayGapPt;
  if (availableColumnHeightPt <= 0) return null;

  const leftBuildFn = (state: ShrinkState, dropped: Set<string>) => {
    const blocks: MeasuredBlock[] = [];
    blocks.push(makeTextBlock("pickupLabel", ctx.pickupLabel, ctx.bold, cfg.pickupLabel.font, cfg.pickupLabel.color, leftLeft, leftWidth, state.fontsShrunk, gapPt(cfg.pickupLabel.gapAfterMm, state.gapShrunk)));
    blocks.push(makeTextBlock("ticketCode", ctx.ticketCode, ctx.bold, cfg.ticketCode.font, cfg.ticketCode.color, leftLeft, leftWidth, state.fontsShrunk, gapPt(cfg.ticketCode.gapAfterMm, state.gapShrunk)));
    blocks.push(makeTextBlock("detailLine", ctx.detailLine, ctx.regular, cfg.detailLine.font, cfg.detailLine.color, leftLeft, leftWidth, state.fontsShrunk, gapPt(cfg.detailLine.gapAfterMm, state.gapShrunk)));
    const hasPaymentLines = !dropped.has("paymentLines") && ctx.paymentLineTexts.length > 0;
    blocks.push(makeTextBlock("requestIdLine", ctx.requestIdLine, ctx.regular, cfg.requestIdLine.font, cfg.requestIdLine.color, leftLeft, leftWidth, state.fontsShrunk, hasPaymentLines ? gapPt(cfg.paymentLines.gapAfterMm, state.gapShrunk) : 0));
    if (hasPaymentLines) {
      blocks.push(makePaymentLinesBlock(ctx.paymentLineTexts, ctx.regular, cfg.paymentLines.font, cfg.paymentLines.color, leftLeft, leftWidth, state.fontsShrunk, cfg.paymentLines.lineGapMm, 0));
    }
    return blocks;
  };
  const leftBlocks = solveBlocks(leftBuildFn, availableColumnHeightPt, ["paymentLines"]);
  if (!leftBlocks) return null;

  const rightBuildFn = (state: ShrinkState, dropped: Set<string>) => {
    if (!ctx.qrImage || dropped.has("qr")) return [];
    const blocks: MeasuredBlock[] = [];
    const qrSizePt = Math.min((state.qrShrunk ? cfg.qr.minSizeMm : cfg.qr.targetSizeMm) * MM_TO_PT, rightWidth);
    blocks.push(makeQrImageBlock(ctx.qrImage, qrSizePt, rightLeft, rightWidth, gapPt(cfg.qr.gapAfterMm, state.gapShrunk)));
    if (!dropped.has("qrCaption")) {
      blocks.push(makeTextBlock("qrCaption", cfg.qrCaption.text, ctx.regular, cfg.qrCaption.font, cfg.qrCaption.color, rightLeft, rightWidth, state.fontsShrunk, 0));
    }
    return blocks;
  };
  const rightBlocks = solveBlocks(rightBuildFn, availableColumnHeightPt, ["qrCaption", "qr"]);
  if (!rightBlocks) return null;

  const topStartY = ctx.pageHeight - marginPt;
  const leftElements = placeBlocks(leftBlocks, topStartY);
  const rightElements = placeBlocks(rightBlocks, topStartY);
  const oxwayElements = oxwayBlock.build(marginPt + oxwayBlock.height);

  return [...leftElements, ...rightElements, ...oxwayElements];
}

/**
 * In landscape, a single column rarely has the vertical room to hold
 * everything (that's the exact bug this layout engine replaces) — so
 * side-by-side is tried first there, falling back to a single column only
 * if the page is too narrow for two columns rather than just short.
 */
function planBannerLayout(ctx: BannerPlanContext): PlannedElement[] | null {
  if (ctx.pageWidth > ctx.pageHeight) {
    return planSideBySide(ctx) ?? planSingleColumn(ctx);
  }
  return planSingleColumn(ctx);
}

/**
 * Computes the full banner layout for `ctx` and checks it against the
 * overlap/margin safety net, throwing BannerSafetyNetViolation if either
 * step fails — exported (alongside buildBannerPlanContext below) so tests
 * can exercise the exact same computation appendBannerPage uses, across
 * many page sizes and job data combinations, without re-deriving pdf-lib
 * operators from a rendered page.
 */
export function computeBannerPlan(ctx: BannerPlanContext): PlannedElement[] {
  const plan = planBannerLayout(ctx);
  if (!plan) throw new NoLayoutFitsError("no computed layout configuration fit within the safe margins at this page size");

  const marginPt = BANNER_LAYOUT_CONFIG.marginMm * MM_TO_PT;
  const violation = validateElements(plan, ctx.pageWidth, ctx.pageHeight, marginPt);
  if (violation) throw new BannerSafetyNetViolation(violation);

  return plan;
}

/**
 * Last-resort layout used when the computed layout above fails its own
 * safety net (or anything else about building it throws) — ticket code,
 * date/time and the Request ID only, at floor font sizes, vertically
 * centered. Simple enough that it's trusted to fit without re-running the
 * safety net against it.
 */
function buildSimpleFallbackElements(bold: PDFFont, regular: PDFFont, pageWidth: number, pageHeight: number, job: PrintJobRecord): PlannedElement[] {
  const cfg = BANNER_LAYOUT_CONFIG.blocks;
  const marginPt = BANNER_LAYOUT_CONFIG.marginMm * MM_TO_PT;
  const columnWidth = Math.max(pageWidth - 2 * marginPt, 1);

  const pickupCode = job.ticketNumber != null ? `#${String(job.ticketNumber).padStart(3, "0")}` : shortRequestId(job.id);
  const timestamp = new Date(job.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const requestIdLine = `${BANNER_LAYOUT_CONFIG.labels.requestIdPrefix}${shortRequestId(job.id)}`;

  const blocks = [
    makeTextBlock("ticketCode", pickupCode, bold, cfg.ticketCode.font, cfg.ticketCode.color, marginPt, columnWidth, true, cfg.ticketCode.gapAfterMm.minMm * MM_TO_PT),
    makeTextBlock("detailLine", timestamp, regular, cfg.detailLine.font, cfg.detailLine.color, marginPt, columnWidth, true, cfg.detailLine.gapAfterMm.minMm * MM_TO_PT),
    makeTextBlock("requestIdLine", requestIdLine, regular, cfg.requestIdLine.font, cfg.requestIdLine.color, marginPt, columnWidth, true, 0),
  ];

  const availableHeightPt = pageHeight - 2 * marginPt;
  const usedHeight = totalStackHeight(blocks);
  const topStartY = pageHeight - marginPt - Math.max(availableHeightPt - usedHeight, 0) / 2;
  return placeBlocks(blocks, topStartY);
}

function commitElements(page: PDFPage, elements: PlannedElement[]): void {
  for (const el of elements) {
    if (el.content.kind === "text") {
      const { text, font, size, color } = el.content;
      const ascent = font.heightAtSize(size, { descender: false });
      const descent = el.rect.height - ascent;
      page.drawText(text, { x: el.rect.x, y: el.rect.y + descent, size, font, color });
    } else {
      page.drawImage(el.content.image, { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height });
    }
  }
}

// ----------------------------------------------------------------------------
// Payment lines (Part B) — "Total paid" and the UPI transaction id / payment id
// ----------------------------------------------------------------------------

function formatRupees(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/**
 * Builds the 0-2 payment lines printed directly under the Request ID line.
 * "Total paid" uses the gateway-confirmed amount if it's been fetched yet
 * (job.paidAmount — see lib/payment-reconciliation.ts), falling back to the
 * job's own charged total_price otherwise, so this line is virtually always
 * present. The second line prefers the UPI transaction id (RRN/UTR), falls
 * back to the Razorpay payment id if that's missing, and is skipped
 * entirely if both are — never prints "undefined"/"null", and never prints
 * a UPI id, card details or phone number.
 */
export function buildPaymentLineTexts(job: Pick<PrintJobRecord, "paidAmount" | "totalPrice" | "upiTxnId" | "paymentId">, font: PDFFont): string[] {
  const lines: string[] = [];

  const amount = job.paidAmount ?? job.totalPrice;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    const symbol = fontCanEncode(font, RUPEE_GLYPH) ? RUPEE_GLYPH : BANNER_LAYOUT_CONFIG.labels.rupeeFallback;
    lines.push(`${BANNER_LAYOUT_CONFIG.labels.totalPaidPrefix}${symbol}${formatRupees(amount)}`);
  }

  const txnId = job.upiTxnId || job.paymentId;
  if (txnId) {
    const prefix = job.upiTxnId ? BANNER_LAYOUT_CONFIG.labels.upiTxnPrefix : BANNER_LAYOUT_CONFIG.labels.paymentIdPrefix;
    lines.push(`${prefix}${txnId}`);
  }

  return lines;
}

// ----------------------------------------------------------------------------
// Instagram QR image loading
// ----------------------------------------------------------------------------

/**
 * Reads public/brand/insta.png once and caches the bytes for the life of
 * this process. Only ever called from appendBannerPage below, which in
 * turn is only ever called from print-agent/index.ts — the website/Vercel
 * never generates the banner at all, so this is a plain Node filesystem
 * read, not something that needs to work inside a Vercel/edge runtime.
 * process.cwd() is the repo root here (see pi/oxway-print-agent.service's
 * own WorkingDirectory), the same way the rest of the print agent already
 * resolves repo-relative paths.
 *
 * Never throws: returns null (and logs once) if the file is missing or
 * unreadable, so a broken/absent image degrades to "banner prints without
 * the QR," never "the print job fails."
 */
let cachedInstaQrBytes: Uint8Array | null | undefined;
async function loadInstaQrBytes(): Promise<Uint8Array | null> {
  if (cachedInstaQrBytes !== undefined) return cachedInstaQrBytes;
  try {
    const filePath = path.join(process.cwd(), ...BANNER_LAYOUT_CONFIG.qrImagePathSegments);
    cachedInstaQrBytes = await readFile(filePath);
  } catch (error) {
    console.warn("Could not read the Instagram QR image — printing the banner without it:", error);
    cachedInstaQrBytes = null;
  }
  return cachedInstaQrBytes;
}

/** Only used by tests, which need to force a fresh (or deliberately failing) read instead of whatever this process already cached. */
export function resetInstaQrCacheForTests(): void {
  cachedInstaQrBytes = undefined;
}

/**
 * Builds the BannerPlanContext for a job — the ticket code, date/time
 * line, Request ID line and payment lines, exactly as appendBannerPage
 * prints them. Exported so tests can build a real, representative context
 * for computeBannerPlan without duplicating this string-building logic.
 */
export function buildBannerPlanContext(bold: PDFFont, regular: PDFFont, qrImage: PDFImage | null, pageWidth: number, pageHeight: number, job: PrintJobRecord): BannerPlanContext {
  const pickupCode = job.ticketNumber != null ? `#${String(job.ticketNumber).padStart(3, "0")}` : shortRequestId(job.id);
  const requestId = shortRequestId(job.id);
  const timestamp = new Date(job.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  // Phone number collection (ROADMAP.md §1) is disabled in this build, so
  // job.phoneNumber is always "" — skip the phone segment instead of
  // printing a blank "Phone ***" on every banner. Picks the phone back up
  // automatically, with no change needed here, if §1 is ever re-enabled.
  const last4 = job.phoneNumber.slice(-4);
  const detailLine = last4 ? `Phone ***${last4}  ·  ${timestamp}` : timestamp;

  return {
    pageWidth,
    pageHeight,
    bold,
    regular,
    qrImage,
    pickupLabel: BANNER_LAYOUT_CONFIG.blocks.pickupLabel.text,
    ticketCode: pickupCode,
    detailLine,
    requestIdLine: `${BANNER_LAYOUT_CONFIG.labels.requestIdPrefix}${requestId}`,
    paymentLineTexts: buildPaymentLineTexts(job, regular),
    oxwayText: BANNER_LAYOUT_CONFIG.blocks.oxway.text,
  };
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

/**
 * Builds a single pickup-ID cover page and appends it to the END of the
 * print-ready PDF — always on, see ROADMAP.md #5. Returns one PDF (the
 * original content first, in its original 1..N order, banner last),
 * submitted to CUPS as a single job (see submitPrintJob in
 * lib/print/cups.ts).
 *
 * Banner LAST, not first: this printer outputs face-down, so whatever
 * prints last ends up on top of the finished stack — the banner needs to
 * be the thing the customer actually sees when they pick up their print,
 * not buried under the content. `contentPdfBytes` is expected to already
 * be each copy's own content, back to back (see expandCopies in
 * lib/print/pdf.ts, called from print-agent/index.ts before this function
 * runs) — appending the banner here, once, after that, is what makes it
 * print exactly once for the whole job regardless of how many copies were
 * ordered, never once per copy.
 *
 * Everything on the banner — the ordered list of blocks, their sizes, gaps,
 * floors and drop priorities — is computed from the page's own real width
 * and height (see BANNER_LAYOUT_CONFIG and computeBannerPlan above), never
 * from hardcoded A4 numbers, so it stays correct across both orientations
 * and any page size. A rectangle-overlap/margin safety net double-checks
 * the result; if that fails (or anything else about building the computed
 * layout throws), this falls back to a minimal layout — ticket code,
 * date/time and the Request ID only — so the print always goes through. In
 * tests specifically, a safety-net failure propagates instead of being
 * silently patched over, so a real layout bug shows up as a failing test
 * rather than a quietly-degraded banner.
 */
export async function appendBannerPage(contentPdfBytes: Uint8Array, job: PrintJobRecord): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const regular = await output.embedFont(StandardFonts.Helvetica);

  // Copied (and added to the page tree immediately below) before the
  // banner page itself so the banner can match the content's actual
  // orientation.
  const content = await PDFDocument.load(contentPdfBytes);
  const contentPages = await output.copyPages(content, content.getPageIndices());
  contentPages.forEach((page) => output.addPage(page));

  // A landscape print job with the banner enabled would otherwise mix a
  // portrait cover sheet in with landscape content pages inside the same
  // CUPS job — a mixed-page-size job that can confuse a printer's
  // fit-to-page handling, and at best just looks wrong: a portrait sheet
  // sitting sideways-relative-to-everything-else in an otherwise-landscape
  // stack. Match extractSelectedPages' own notion of orientation (width vs
  // height of the already-processed content) rather than re-deriving it.
  const [firstContentPage] = contentPages;
  const isContentLandscape = firstContentPage.getWidth() > firstContentPage.getHeight();
  const bannerWidth = isContentLandscape ? A4_HEIGHT : A4_WIDTH;
  const bannerHeight = isContentLandscape ? A4_WIDTH : A4_HEIGHT;

  const banner = output.addPage([bannerWidth, bannerHeight]);

  let finalElements: PlannedElement[];
  try {
    let qrImage: PDFImage | null = null;
    try {
      const instaQrBytes = await loadInstaQrBytes();
      if (instaQrBytes) qrImage = await output.embedPng(instaQrBytes);
    } catch (error) {
      console.warn("Could not embed the Instagram QR image — continuing without it:", error);
    }

    const ctx = buildBannerPlanContext(bold, regular, qrImage, bannerWidth, bannerHeight, job);
    finalElements = computeBannerPlan(ctx);
  } catch (error) {
    // The one case this must NOT be swallowed: a genuine safety-net
    // violation surfacing during tests, which should fail loudly rather
    // than quietly fall back — see this function's own comment above.
    if (error instanceof BannerSafetyNetViolation && process.env.NODE_ENV === "test") throw error;
    console.warn("Could not build the computed banner layout — falling back to the simple layout:", error);
    finalElements = buildSimpleFallbackElements(bold, regular, bannerWidth, bannerHeight, job);
  }

  commitElements(banner, finalElements);

  return output.save();
}
