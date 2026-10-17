export type PickupMode = "here" | "later";
export type SeparatorMode = "auto" | "always" | "never";
export type SheetKind = "none" | "separator" | "cover";

export function decideSheetKind(input: {
  pickupMode: PickupMode;
  separatorMode: SeparatorMode;
  forceCoverSheet: boolean;
  trayLikelyOccupied: boolean;
  physicalSheets: number;
  largeJobPages: number;
}): SheetKind {
  if (input.forceCoverSheet) return "cover";
  if (input.pickupMode === "later") return "cover";
  if (input.separatorMode === "never") return "none";
  if (input.separatorMode === "always") return "separator";
  if (input.trayLikelyOccupied) return "separator";
  if (input.physicalSheets >= input.largeJobPages) return "separator";
  return "none";
}
