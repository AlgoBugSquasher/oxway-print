import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { shortRequestId } from "../request-id";
import type { PrintJobRecord } from "../store";
import { formatTicketCode } from "../ticket-code";
import { commitElements, makeTextBlock, MM_TO_PT, placeBlocks, totalStackHeight } from "./banner";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_MM = 12;

export const SEPARATOR_LAYOUT_CONFIG = {
  code: { font: { normalPt: 150, minPt: 60 }, color: rgb(0.1, 0.1, 0.1), gapAfterMm: 10 },
  detail: { font: { normalPt: 20, minPt: 14 }, color: rgb(0.35, 0.38, 0.43), gapAfterMm: 0 },
} as const;

export async function prependSeparatorPage(contentPdfBytes: Uint8Array, job: PrintJobRecord): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const regular = await output.embedFont(StandardFonts.Helvetica);

  const content = await PDFDocument.load(contentPdfBytes);
  const contentPageIndices = content.getPageIndices();
  const firstContentPage = content.getPage(contentPageIndices[0]);
  const isContentLandscape = firstContentPage.getWidth() > firstContentPage.getHeight();
  const width = isContentLandscape ? A4_HEIGHT : A4_WIDTH;
  const height = isContentLandscape ? A4_WIDTH : A4_HEIGHT;

  const marginPt = MARGIN_MM * MM_TO_PT;
  const columnWidth = width - 2 * marginPt;
  const cfg = SEPARATOR_LAYOUT_CONFIG;

  const code = job.ticketNumber != null ? formatTicketCode(job.ticketNumber) : shortRequestId(job.id);
  const timestamp = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

  const blocks = [
    makeTextBlock("code", code, bold, cfg.code.font, cfg.code.color, marginPt, columnWidth, false, cfg.code.gapAfterMm * MM_TO_PT, false),
    makeTextBlock("detail", timestamp, regular, cfg.detail.font, cfg.detail.color, marginPt, columnWidth, false, cfg.detail.gapAfterMm * MM_TO_PT),
  ];

  const availableHeightPt = height - 2 * marginPt;
  const usedHeight = totalStackHeight(blocks);
  const topStartY = height - marginPt - Math.max(availableHeightPt - usedHeight, 0) / 2;

  const page = output.addPage([width, height]);
  commitElements(page, placeBlocks(blocks, topStartY));

  const contentPages = await output.copyPages(content, contentPageIndices);
  contentPages.forEach((p) => output.addPage(p));

  return output.save();
}
