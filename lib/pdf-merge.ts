import { PDFDocument } from "pdf-lib";
import { reportClientError } from "./client-log";

/** Marks the two deliberate, already-customer-readable throws below (names the bad file, or says nothing was selected) — anything else (a pdf-lib internal failure, a browser quirk) is NOT one of these and gets replaced with a generic friendly message instead of leaking a raw library error onto the screen. */
class MergeInputError extends Error {}

export interface MergeSourceFile {
  /** Used only to name the file in an error message if its bytes can't be read — never printed, never sent anywhere. */
  fileName: string;
  /** Already-converted, print-ready PDF bytes (see lib/client-file-converter.ts / useFileBasket.ts) — this module only selects and reorders pages, it never converts a source file itself. */
  pdfBytes: Uint8Array;
  /** 1-indexed page numbers to include from this file. Order doesn't need to be pre-sorted — this function sorts each file's own pages ascending before extracting, same as extractSelectedPages in lib/print/pdf.ts does for a single file. */
  selectedPages: number[];
}

export interface MergedPdf {
  bytes: Uint8Array;
  pageCount: number;
}

/**
 * Combines the selected pages of one or more already-converted PDFs into a
 * single PDF, in list order — file 1's selected pages (ascending), then
 * file 2's, and so on. Runs entirely client-side (see PdfPageSelector.tsx's
 * handleStartPayment, the only caller): every basket item's pdfBytes
 * already lives in memory from its own conversion step, so merging here
 * costs no extra network or file I/O, and it means only the pages the
 * customer actually chose are ever uploaded — not every page of every file.
 *
 * Each page is copied with pdf-lib's copyPages, never re-rendered or
 * re-drawn, so its own size and rotation carry over exactly as they already
 * were. This deliberately does NOT rotate anything to match the customer's
 * chosen print Layout (portrait/landscape) — that's a separate, already
 * -existing, server-side step (extractSelectedPages in lib/print/pdf.ts,
 * run again authoritatively on the merged upload by app/api/create-order)
 * that already handles a document with mixed portrait/landscape pages
 * correctly. Doing that rotation here too would mean making the same
 * decision twice, once on data the server doesn't trust yet — simpler and
 * more honest for this module to just combine pages as they are and leave
 * orientation to the one place that's already responsible for it.
 *
 * Throws, naming the file, if any file's bytes can't be parsed as a PDF —
 * never silently drops a file or produces a merged PDF missing pages
 * without saying why. Also throws if the combined selection has no pages
 * at all (every file empty, or an empty file list).
 *
 * Wrapped (not thrown directly from the body below) so that anything
 * pdf-lib itself throws internally — a bundling/version hiccup, a
 * malformed PDF neither of the two checks above catches, anything — never
 * reaches the customer as a raw library error string. The two deliberate
 * MergeInputErrors below are already written in plain language and pass
 * through unchanged; everything else is logged with the real error (see
 * reportClientError) and replaced with one generic message.
 */
export async function mergeSelectedPdfPages(files: MergeSourceFile[]): Promise<MergedPdf> {
  try {
    return await mergeSelectedPdfPagesUnsafe(files);
  } catch (error) {
    if (error instanceof MergeInputError) throw error;
    reportClientError("pdf-merge-failed", error, { fileCount: files.length });
    throw new Error("We couldn't process this file, please try again.");
  }
}

async function mergeSelectedPdfPagesUnsafe(files: MergeSourceFile[]): Promise<MergedPdf> {
  const output = await PDFDocument.create();

  for (const file of files) {
    if (file.selectedPages.length === 0) continue;

    let source: PDFDocument;
    try {
      source = await PDFDocument.load(file.pdfBytes);
    } catch (loadError) {
      throw new MergeInputError(`"${file.fileName}" could not be read while combining your files — try removing and re-adding it.`, { cause: loadError });
    }

    const sortedPages = [...file.selectedPages].sort((a, b) => a - b);
    const zeroIndexed = sortedPages
      .map((pageNumber) => pageNumber - 1)
      .filter((index) => index >= 0 && index < source.getPageCount());
    if (zeroIndexed.length === 0) continue;

    const pages = await output.copyPages(source, zeroIndexed);
    pages.forEach((page) => output.addPage(page));
  }

  if (output.getPageCount() === 0) {
    throw new MergeInputError("No pages selected across any file.");
  }

  return { bytes: await output.save(), pageCount: output.getPageCount() };
}
