import { describe, expect, it } from "vitest";
import { computeQrModuleRuns, generateQrMatrix, qrModuleSizePt, type QrMatrix } from "./qr";

describe("generateQrMatrix", () => {
  it("generates a real, non-trivial module grid for a URL", () => {
    const matrix = generateQrMatrix("https://www.instagram.com/oxway.geu/", "M");
    expect(matrix.size).toBeGreaterThan(20);
    let darkCount = 0;
    for (let row = 0; row < matrix.size; row++) {
      for (let col = 0; col < matrix.size; col++) {
        if (matrix.isDark(row, col)) darkCount += 1;
      }
    }
    expect(darkCount).toBeGreaterThan(0);
    expect(darkCount).toBeLessThan(matrix.size * matrix.size);
  });

  it("produces a bigger grid for a longer payload", () => {
    const short = generateQrMatrix("https://x.co", "M");
    const long = generateQrMatrix(`https://example.com/${"a".repeat(500)}`, "M");
    expect(long.size).toBeGreaterThan(short.size);
  });

  it("is deterministic for the same input", () => {
    const a = generateQrMatrix("https://www.instagram.com/oxway.geu/", "M");
    const b = generateQrMatrix("https://www.instagram.com/oxway.geu/", "M");
    expect(a.size).toBe(b.size);
    for (let row = 0; row < a.size; row++) {
      for (let col = 0; col < a.size; col++) {
        expect(a.isDark(row, col)).toBe(b.isDark(row, col));
      }
    }
  });
});

/** A small, hand-built square matrix so the merge logic can be checked against an exact, known layout rather than the real (much bigger, harder to eyeball) Instagram URL grid. Every row string must be exactly as long as the number of rows — a real QR module grid is always square. */
function matrixFromRows(rows: string[]): QrMatrix {
  const size = rows.length;
  if (rows.some((row) => row.length !== size)) throw new Error("matrixFromRows fixture must be square");
  return { size, isDark: (row, col) => rows[row][col] === "#" };
}

describe("computeQrModuleRuns", () => {
  it("merges consecutive dark modules in a row into one run", () => {
    const matrix = matrixFromRows([".###.", ".....", ".....", ".....", "....."]);
    const runs = computeQrModuleRuns(matrix, 0);
    expect(runs).toEqual([{ row: 0, col: 1, columnSpan: 3 }]);
  });

  it("keeps separate runs for non-adjacent dark modules in the same row", () => {
    const matrix = matrixFromRows(["#.#.#", ".....", ".....", ".....", "....."]);
    const runs = computeQrModuleRuns(matrix, 0);
    expect(runs).toEqual([
      { row: 0, col: 0, columnSpan: 1 },
      { row: 0, col: 2, columnSpan: 1 },
      { row: 0, col: 4, columnSpan: 1 },
    ]);
  });

  it("produces one run per row, each offset by the row index", () => {
    const matrix = matrixFromRows(["##...", ".##..", "..##.", "...##", "....."]);
    const runs = computeQrModuleRuns(matrix, 0);
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => r.row)).toEqual([0, 1, 2, 3]);
  });

  it("offsets every run by the quiet zone, in both row and column", () => {
    const matrix = matrixFromRows(["##", ".."]);
    const runs = computeQrModuleRuns(matrix, 4);
    expect(runs).toEqual([{ row: 4, col: 4, columnSpan: 2 }]);
  });

  it("produces no runs for an all-light matrix", () => {
    const matrix = matrixFromRows(["..", ".."]);
    expect(computeQrModuleRuns(matrix, 0)).toEqual([]);
  });

  it("merges a run that extends to the matrix's own right edge", () => {
    const matrix = matrixFromRows(["..###", ".....", ".....", ".....", "....."]);
    const runs = computeQrModuleRuns(matrix, 0);
    expect(runs).toEqual([{ row: 0, col: 2, columnSpan: 3 }]);
  });
});

describe("qrModuleSizePt", () => {
  it("divides the box size by the code size plus the quiet zone on both sides", () => {
    const matrix = matrixFromRows(["..", ".."]); // size 2
    expect(qrModuleSizePt(matrix, 100, 4)).toBeCloseTo(100 / (2 + 8), 6);
  });

  it("scales up as the box size grows", () => {
    const matrix = matrixFromRows(["..", ".."]);
    expect(qrModuleSizePt(matrix, 200, 4)).toBeGreaterThan(qrModuleSizePt(matrix, 100, 4));
  });

  it("shrinks as the quiet zone grows, for a fixed box size", () => {
    const matrix = matrixFromRows(["..", ".."]);
    expect(qrModuleSizePt(matrix, 100, 8)).toBeLessThan(qrModuleSizePt(matrix, 100, 4));
  });
});
