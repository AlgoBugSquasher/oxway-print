import { PDFDocument } from "pdf-lib";

/**
 * Extracts only the pages the customer selected (in order) from the
 * uploaded PDF. Copies and pages-per-sheet layout are applied at the CUPS
 * level (see lib/print/cups.ts) rather than by rewriting the PDF, since the
 * printer driver handles N-up composition more reliably than re-flowing
 * content here.
 */
export async function extractSelectedPages(originalBytes: Uint8Array, selectedPages: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(originalBytes);
  const output = await PDFDocument.create();

  const sortedPages = [...selectedPages].sort((a, b) => a - b);
  const zeroIndexed = sortedPages
    .map((pageNumber) => pageNumber - 1)
    .filter((index) => index >= 0 && index < source.getPageCount());

  if (zeroIndexed.length === 0) {
    throw new Error("No valid pages selected to print.");
  }

  const copiedPages = await output.copyPages(source, zeroIndexed);
  copiedPages.forEach((page) => output.addPage(page));

  return output.save();
}
