import { describe, expect, it } from "vitest";
import { formatPageRangeLabel, formatReprintNote } from "./reprint-note";

describe("formatPageRangeLabel", () => {
  it("formats a contiguous range as 'X to Y' — requirement: 'reprinted pages X to Y'", () => {
    expect(formatPageRangeLabel([2, 3, 4])).toBe("2 to 4");
  });

  it("formats a single page with no range at all", () => {
    expect(formatPageRangeLabel([5])).toBe("5");
  });

  it("formats a mix of a range and standalone pages", () => {
    expect(formatPageRangeLabel([2, 3, 4, 7])).toBe("2 to 4, 7");
  });

  it("formats entirely non-contiguous pages as separate entries", () => {
    expect(formatPageRangeLabel([1, 3, 5])).toBe("1, 3, 5");
  });

  it("de-duplicates and sorts an unordered, repeated input", () => {
    expect(formatPageRangeLabel([4, 2, 3, 2])).toBe("2 to 4");
  });

  it("returns an empty string for an empty selection", () => {
    expect(formatPageRangeLabel([])).toBe("");
  });
});

describe("formatReprintNote", () => {
  it("reads 'Reprinted pages X to Y on <date>.' for a multi-page range, in Asia/Kolkata", () => {
    // 2026-10-17T05:00:00Z = 2026-10-17 10:30 AM IST.
    const note = formatReprintNote([2, 3, 4], new Date("2026-10-17T05:00:00Z"));
    expect(note).toBe("Reprinted pages 2 to 4 on 17 Oct 2026, 10:30 am.");
  });

  it("uses singular 'page' (not 'pages') for a single selected page", () => {
    const note = formatReprintNote([5], new Date("2026-10-17T05:00:00Z"));
    expect(note).toBe("Reprinted page 5 on 17 Oct 2026, 10:30 am.");
  });

  it("renders in Asia/Kolkata regardless of the server's own timezone — a UTC-midnight instant still reads as the IST evening before", () => {
    // 2026-10-17T00:00:00Z = 2026-10-17 05:30 AM IST — picked specifically
    // because a naive (non-timezone-aware) formatter would show midnight,
    // not 5:30 AM, if this ever regressed to the server's local/UTC clock.
    const note = formatReprintNote([1], new Date("2026-10-17T00:00:00Z"));
    expect(note).toContain("17 Oct 2026, 5:30 am");
  });
});
