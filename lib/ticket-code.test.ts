import { describe, expect, it } from "vitest";
import { formatTicketCode } from "./ticket-code";

describe("formatTicketCode", () => {
  it("pads a small ticket number to 3 digits", () => {
    expect(formatTicketCode(1)).toBe("#001");
    expect(formatTicketCode(42)).toBe("#042");
    expect(formatTicketCode(99)).toBe("#099");
  });

  it("does not pad a 3-digit ticket number further", () => {
    expect(formatTicketCode(100)).toBe("#100");
    expect(formatTicketCode(999)).toBe("#999");
  });

  it("never truncates a 4 or 5 digit ticket number back down to 3 digits", () => {
    expect(formatTicketCode(1000)).toBe("#1000");
    expect(formatTicketCode(9999)).toBe("#9999");
    expect(formatTicketCode(10000)).toBe("#10000");
    expect(formatTicketCode(99999)).toBe("#99999");
  });

  it("rolls over past 999 with no reset or collision with any padded 3-digit code", () => {
    expect(formatTicketCode(999)).toBe("#999");
    expect(formatTicketCode(1000)).toBe("#1000");
    expect(formatTicketCode(1000)).not.toBe(formatTicketCode(100)); // "#1000" !== "#100"
  });
});
