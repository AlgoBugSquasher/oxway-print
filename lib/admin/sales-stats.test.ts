import { describe, expect, it } from "vitest";
import { colorShare, findBusiestWeekday, findDayExtremes, findPeakHour, formatHourLabel, hourlyBarHeights, WEEKDAY_LABELS } from "./sales-stats";
import type { DailyPatternRow, HourlyPatternRow, WeekdayPatternRow } from "./types";

function emptyHours(): HourlyPatternRow[] {
  return Array.from({ length: 24 }, (_, hour_of_day) => ({ hour_of_day, job_count: 0, pages_printed: 0 }));
}

function emptyWeekdays(): WeekdayPatternRow[] {
  return Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, job_count: 0, pages_printed: 0 }));
}

function days(counts: number[]): DailyPatternRow[] {
  return counts.map((job_count, i) => ({ day: `2026-10-${10 + i}`, job_count, pages_printed: job_count * 2 }));
}

describe("findPeakHour", () => {
  it("returns null for an empty list", () => {
    expect(findPeakHour([])).toBeNull();
  });

  it("returns null when every hour is empty (no activity yet)", () => {
    expect(findPeakHour(emptyHours())).toBeNull();
  });

  it("finds the one hour with activity when there's a single job", () => {
    const rows = emptyHours();
    rows[14] = { hour_of_day: 14, job_count: 1, pages_printed: 3 };
    expect(findPeakHour(rows)?.hour_of_day).toBe(14);
  });

  it("picks the busiest of several non-empty hours", () => {
    const rows = emptyHours();
    rows[9] = { hour_of_day: 9, job_count: 2, pages_printed: 4 };
    rows[17] = { hour_of_day: 17, job_count: 5, pages_printed: 10 };
    expect(findPeakHour(rows)?.hour_of_day).toBe(17);
  });
});

describe("findBusiestWeekday", () => {
  it("returns null for an empty list", () => {
    expect(findBusiestWeekday([])).toBeNull();
  });

  it("returns null when every weekday is empty", () => {
    expect(findBusiestWeekday(emptyWeekdays())).toBeNull();
  });

  it("finds the one weekday with activity when there's a single job", () => {
    const rows = emptyWeekdays();
    rows[3] = { day_of_week: 3, job_count: 1, pages_printed: 2 };
    expect(findBusiestWeekday(rows)?.day_of_week).toBe(3);
  });
});

describe("findDayExtremes", () => {
  it("returns null/null for an empty list", () => {
    expect(findDayExtremes([])).toEqual({ busiest: null, quietest: null });
  });

  it("returns null/null for a single-day period (nothing to compare)", () => {
    expect(findDayExtremes(days([5]))).toEqual({ busiest: null, quietest: null });
  });

  it("returns null/null when every day in a multi-day period is empty", () => {
    expect(findDayExtremes(days([0, 0, 0]))).toEqual({ busiest: null, quietest: null });
  });

  it("finds the busiest and quietest (possibly zero) day across a multi-day period", () => {
    const rows = days([2, 0, 7, 3]);
    const extremes = findDayExtremes(rows);
    expect(extremes.busiest?.job_count).toBe(7);
    expect(extremes.quietest?.job_count).toBe(0);
  });
});

describe("colorShare", () => {
  it("returns null when nothing has printed yet", () => {
    expect(colorShare(0, 0)).toBeNull();
  });

  it("computes a 100/0 split for a single color job", () => {
    expect(colorShare(1, 0)).toEqual({ colorPercent: 100, bwPercent: 0 });
  });

  it("computes a 25/75 split", () => {
    expect(colorShare(1, 3)).toEqual({ colorPercent: 25, bwPercent: 75 });
  });
});

describe("hourlyBarHeights", () => {
  it("returns 24 zero heights for an all-empty pattern", () => {
    const heights = hourlyBarHeights(emptyHours());
    expect(heights).toHaveLength(24);
    expect(heights.every((h) => h === 0)).toBe(true);
  });

  it("gives the single busy hour a full-height bar and leaves the rest at zero", () => {
    const rows = emptyHours();
    rows[8] = { hour_of_day: 8, job_count: 4, pages_printed: 9 };
    const heights = hourlyBarHeights(rows);
    expect(heights[8]).toBe(1);
    expect(heights.filter((h) => h > 0)).toHaveLength(1);
  });
});

describe("formatHourLabel", () => {
  it("formats midnight as 12am", () => {
    expect(formatHourLabel(0)).toBe("12am");
  });

  it("formats noon as 12pm", () => {
    expect(formatHourLabel(12)).toBe("12pm");
  });

  it("formats an afternoon hour", () => {
    expect(formatHourLabel(17)).toBe("5pm");
  });
});

describe("WEEKDAY_LABELS", () => {
  it("has exactly 7 entries starting from Sunday, matching the RPC's day_of_week convention", () => {
    expect(WEEKDAY_LABELS).toHaveLength(7);
    expect(WEEKDAY_LABELS[0]).toBe("Sun");
  });
});
