import { describe, expect, it } from "vitest";
import type { PrintSettingsSnapshot } from "../store";
import { buildLpArgs } from "./cups";

// Direct, deterministic assertions on the exact `lp` arguments built for a
// given settings combination — catches an accidental change to any of
// these -o options (fit-to-page, media, number-up, print-color-mode) or to
// the always-one-copy contract, without needing to mock execFile/lp.

function settings(overrides: Partial<PrintSettingsSnapshot> = {}): PrintSettingsSnapshot {
  return {
    copies: 1,
    layout: "portrait",
    isColor: false,
    paperSize: "A4",
    pagesPerSheet: 1,
    ...overrides,
  };
}

describe("buildLpArgs", () => {
  it("builds the baseline B&W A4 single-up args", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings())).toEqual([
      "-n", "1",
      "-o", "media=a4",
      "-o", "number-up=1",
      "-o", "fit-to-page",
      "-o", "print-color-mode=monochrome",
      "/tmp/job.pdf",
    ]);
  });

  it("always submits exactly one CUPS-level copy, regardless of the job's own copies setting — copies are baked into the PDF before this is ever called", () => {
    for (const copies of [1, 2, 5]) {
      const args = buildLpArgs("/tmp/job.pdf", settings({ copies }));
      expect(args[0]).toBe("-n");
      expect(args[1]).toBe("1");
    }
  });

  it("never sets orientation-requested — content geometry alone decides orientation (see lib/print/pdf.ts)", () => {
    for (const layout of ["portrait", "landscape"] as const) {
      const args = buildLpArgs("/tmp/job.pdf", settings({ layout }));
      expect(args).not.toContain("orientation-requested");
      expect(args.some((arg) => arg.startsWith("orientation-requested"))).toBe(false);
    }
  });

  it("maps paperSize to the right media option", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize: "A4" }))).toContain("media=a4");
    expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize: "Letter" }))).toContain("media=letter");
    expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize: "Legal" }))).toContain("media=legal");
  });

  it("maps pagesPerSheet to number-up", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ pagesPerSheet: 1 }))).toContain("number-up=1");
    expect(buildLpArgs("/tmp/job.pdf", settings({ pagesPerSheet: 2 }))).toContain("number-up=2");
    expect(buildLpArgs("/tmp/job.pdf", settings({ pagesPerSheet: 4 }))).toContain("number-up=4");
  });

  it("maps isColor to print-color-mode", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ isColor: false }))).toContain("print-color-mode=monochrome");
    expect(buildLpArgs("/tmp/job.pdf", settings({ isColor: true }))).toContain("print-color-mode=color");
  });

  it("always includes fit-to-page, unconditionally", () => {
    for (const paperSize of ["A4", "Letter", "Legal"] as const) {
      expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize }))).toContain("fit-to-page");
    }
  });

  it("appends the file path last", () => {
    const args = buildLpArgs("/tmp/some/job-42.pdf", settings());
    expect(args.at(-1)).toBe("/tmp/some/job-42.pdf");
  });

  it("builds the exact args for a full non-default combination (color, Letter, 4-up)", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ isColor: true, paperSize: "Letter", pagesPerSheet: 4, copies: 3 }))).toEqual([
      "-n", "1",
      "-o", "media=letter",
      "-o", "number-up=4",
      "-o", "fit-to-page",
      "-o", "print-color-mode=color",
      "/tmp/job.pdf",
    ]);
  });
});
