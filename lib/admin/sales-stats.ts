import type { DailyPatternRow, HourlyPatternRow, WeekdayPatternRow } from "./types";

/**
 * Pure helpers over get_kiosk_hourly_pattern/get_kiosk_weekday_pattern/
 * get_kiosk_daily_pattern's rows — same reasoning as period-stats.ts:
 * the RPCs already did the expensive part (scanning print_orders once, in
 * SQL, dense zero-filled); picking out "the busiest one" from a handful of
 * rows is cheap client-side.
 */

const HOURS_PER_DAY = 24;
const NOON_HOUR = 12;

/** day_of_week follows the RPC's own convention (0 = Sunday .. 6 = Saturday, matching JS Date.getDay()). */
export const WEEKDAY_LABELS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatHourLabel(hourOfDay: number): string {
  const period = hourOfDay < NOON_HOUR ? "am" : "pm";
  const displayHour = hourOfDay % NOON_HOUR === 0 ? NOON_HOUR : hourOfDay % NOON_HOUR;
  return `${displayHour}${period}`;
}

/** The single busiest hour by job_count — null when every hour is empty (nothing to call "peak" yet) or the list is empty. Ties keep the earliest hour. */
export function findPeakHour(rows: HourlyPatternRow[]): HourlyPatternRow | null {
  if (rows.length === 0) return null;
  const peak = rows.reduce((best, row) => (row.job_count > best.job_count ? row : best), rows[0]);
  return peak.job_count > 0 ? peak : null;
}

/** The single busiest day-of-week by job_count — null when every weekday is empty or the list is empty. Ties keep the earliest (Sunday-first) weekday. */
export function findBusiestWeekday(rows: WeekdayPatternRow[]): WeekdayPatternRow | null {
  if (rows.length === 0) return null;
  const busiest = rows.reduce((best, row) => (row.job_count > best.job_count ? row : best), rows[0]);
  return busiest.job_count > 0 ? busiest : null;
}

export interface DayExtremes {
  busiest: DailyPatternRow | null;
  quietest: DailyPatternRow | null;
}

/**
 * The busiest and quietest calendar day within the period — null for both
 * when the period only spans a single day (nothing to compare yet, e.g.
 * the "Today" period) or when every day is empty. A quietest day can
 * legitimately have zero jobs — that's a real answer, not a missing one.
 */
export function findDayExtremes(rows: DailyPatternRow[]): DayExtremes {
  if (rows.length <= 1) return { busiest: null, quietest: null };
  const anyActivity = rows.some((row) => row.job_count > 0);
  if (!anyActivity) return { busiest: null, quietest: null };
  const busiest = rows.reduce((best, row) => (row.job_count > best.job_count ? row : best), rows[0]);
  const quietest = rows.reduce((least, row) => (row.job_count < least.job_count ? row : least), rows[0]);
  return { busiest, quietest };
}

export interface ColorShare {
  colorPercent: number;
  bwPercent: number;
}

/** Color vs. B&W split as whole-number percentages — null when there's nothing printed yet (an empty state, not a 0/0 share). */
export function colorShare(colorJobs: number, bwJobs: number): ColorShare | null {
  const total = colorJobs + bwJobs;
  if (total === 0) return null;
  const colorPercent = Math.round((colorJobs / total) * 100);
  return { colorPercent, bwPercent: 100 - colorPercent };
}

/** Builds a dense, always-24-entry array even if the RPC somehow returned fewer rows — the bar chart indexes by hour directly. */
export function hourlyBarHeights(rows: HourlyPatternRow[]): number[] {
  const byHour = new Map(rows.map((row) => [row.hour_of_day, row.job_count]));
  const maxCount = Math.max(1, ...rows.map((row) => row.job_count));
  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => (byHour.get(hour) ?? 0) / maxCount);
}
