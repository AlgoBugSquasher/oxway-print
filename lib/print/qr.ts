import QRCode from "qrcode";

/** A generated QR code's module grid — row/col indexed, (0, 0) at the top-left, exactly as the `qrcode` library itself lays it out. */
export interface QrMatrix {
  size: number;
  isDark(row: number, col: number): boolean;
}

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

/**
 * Generates a QR code's module grid for `text` — pure data, no rendering.
 * The caller (lib/print/banner.ts) draws every dark module as its own
 * vector-filled rectangle directly in the PDF rather than ever producing a
 * raster image: a plain black-on-white vector QR survives a B&W laser
 * printer far more reliably than an embedded image can — a gradient or
 * anti-aliased edge prints as light grey dots a phone camera can't always
 * pick up, which pure black fills never do.
 */
export function generateQrMatrix(text: string, errorCorrectionLevel: QrErrorCorrectionLevel): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel });
  return { size: modules.size, isDark: (row, col) => modules.get(row, col) === 1 };
}

/**
 * One drawable run: `columnSpan` consecutive dark modules in a single row,
 * merged into the one rectangle that will actually draw them — far fewer
 * fill operations than one rectangle per module for a 25-45+ module grid.
 * Coordinates are in module units, already offset by the quiet zone, so
 * (0, 0) is the quiet-zone-inclusive box's own top-left corner, not the
 * bare code's — the caller never needs to add the quiet zone back in.
 */
export interface QrModuleRun {
  row: number;
  col: number;
  columnSpan: number;
}

/** Every dark module in `matrix`, run-length-encoded along each row — see QrModuleRun. */
export function computeQrModuleRuns(matrix: QrMatrix, quietZoneModules: number): QrModuleRun[] {
  const runs: QrModuleRun[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let runStartCol = -1;
    for (let col = 0; col <= matrix.size; col++) {
      const dark = col < matrix.size && matrix.isDark(row, col);
      if (dark && runStartCol === -1) runStartCol = col;
      if (!dark && runStartCol !== -1) {
        runs.push({ row: row + quietZoneModules, col: runStartCol + quietZoneModules, columnSpan: col - runStartCol });
        runStartCol = -1;
      }
    }
  }
  return runs;
}

/** The side length of a single module, in points, when the whole code — including the quiet zone on every side — is drawn at `boxSizePt` square. */
export function qrModuleSizePt(matrix: QrMatrix, boxSizePt: number, quietZoneModules: number): number {
  return boxSizePt / (matrix.size + quietZoneModules * 2);
}
