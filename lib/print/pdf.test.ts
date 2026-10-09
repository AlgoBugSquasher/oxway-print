import { describe, expect, it } from "vitest";
import { looksLikePdf } from "./pdf";

describe("looksLikePdf", () => {
  it("accepts bytes starting with the %PDF magic header", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n...rest of a real pdf...");
    expect(looksLikePdf(bytes)).toBe(true);
  });

  it("rejects bytes that don't start with %PDF — e.g. a renamed non-PDF file", () => {
    const bytes = new TextEncoder().encode("PK\x03\x04 this is actually a zip/docx");
    expect(looksLikePdf(bytes)).toBe(false);
  });

  it("rejects an empty or truncated upload rather than throwing on out-of-bounds access", () => {
    expect(looksLikePdf(new Uint8Array())).toBe(false);
    expect(looksLikePdf(new Uint8Array([0x25, 0x50]))).toBe(false); // "%P", cut short
  });
});
