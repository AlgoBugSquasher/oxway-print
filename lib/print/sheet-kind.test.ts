import { describe, expect, it } from "vitest";
import { decideSheetKind } from "./sheet-kind";

function base(overrides: Partial<Parameters<typeof decideSheetKind>[0]> = {}): Parameters<typeof decideSheetKind>[0] {
  return {
    pickupMode: "here",
    separatorMode: "auto",
    forceCoverSheet: false,
    trayLikelyOccupied: false,
    physicalSheets: 2,
    largeJobPages: 15,
    ...overrides,
  };
}

describe("decideSheetKind", () => {
  it("empty tray, small here-job: no extra sheet", () => {
    expect(decideSheetKind(base())).toBe("none");
  });

  it("collect-later always gets the full cover sheet, even on an empty tray", () => {
    expect(decideSheetKind(base({ pickupMode: "later" }))).toBe("cover");
  });

  it("back-to-back jobs: tray likely occupied forces a separator for an I'm-here job", () => {
    expect(decideSheetKind(base({ trayLikelyOccupied: true }))).toBe("separator");
  });

  it("large job gets a separator even on an empty tray", () => {
    expect(decideSheetKind(base({ physicalSheets: 15, largeJobPages: 15 }))).toBe("separator");
  });

  it("separatorMode never turns separators off entirely, including for a large job", () => {
    expect(decideSheetKind(base({ separatorMode: "never", trayLikelyOccupied: true, physicalSheets: 999 }))).toBe("none");
  });

  it("separatorMode always forces a separator even on an empty tray with a tiny job", () => {
    expect(decideSheetKind(base({ separatorMode: "always" }))).toBe("separator");
  });

  it("forceCoverSheet overrides everything, including never", () => {
    expect(decideSheetKind(base({ separatorMode: "never", forceCoverSheet: true }))).toBe("cover");
  });

  it("collect-later then I'm-here: a later job still always gets the cover regardless of tray state", () => {
    expect(decideSheetKind(base({ pickupMode: "later", trayLikelyOccupied: true, separatorMode: "never" }))).toBe("cover");
  });
});
