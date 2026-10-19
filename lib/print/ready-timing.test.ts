import { describe, expect, it } from "vitest";
import { READY_TIMING_CONFIG, STUCK_JOB_TIMEOUT_HOURS, computeMinimumReadyAtMs, computeStuckJobDeadlineMs, decidePrintWatchOutcome, needsWarmup } from "./ready-timing";

describe("needsWarmup", () => {
  it("needs warmup when the agent has never finished a job before (null — just restarted)", () => {
    expect(needsWarmup(1_000_000, null)).toBe(true);
  });

  it("needs warmup when the printer sat idle at or beyond the configured threshold", () => {
    const claimedAtMs = 1_000_000;
    const lastJobFinishedAtMs = claimedAtMs - READY_TIMING_CONFIG.warmupIdleThresholdSeconds * 1000;
    expect(needsWarmup(claimedAtMs, lastJobFinishedAtMs)).toBe(true);
  });

  it("does not need warmup when the printer just finished a job moments ago", () => {
    const claimedAtMs = 1_000_000;
    const lastJobFinishedAtMs = claimedAtMs - 5_000; // 5s ago, well under the threshold
    expect(needsWarmup(claimedAtMs, lastJobFinishedAtMs)).toBe(false);
  });
});

describe("computeMinimumReadyAtMs", () => {
  it("computes spooledAt + sheets*secPerPage + grace, with no warmup added", () => {
    const spooledAtMs = 1_000_000;
    const physicalSheets = 4;
    const expected = spooledAtMs + (physicalSheets * READY_TIMING_CONFIG.secPerPageSeconds + READY_TIMING_CONFIG.graceSeconds) * 1000;
    expect(computeMinimumReadyAtMs(spooledAtMs, physicalSheets, false)).toBe(expected);
  });

  it("adds warmupSeconds on top when warmup is needed", () => {
    const spooledAtMs = 1_000_000;
    const physicalSheets = 4;
    const withoutWarmup = computeMinimumReadyAtMs(spooledAtMs, physicalSheets, false);
    const withWarmup = computeMinimumReadyAtMs(spooledAtMs, physicalSheets, true);
    expect(withWarmup - withoutWarmup).toBe(READY_TIMING_CONFIG.warmupSeconds * 1000);
  });

  it("scales with more sheets (more copies/pages means a later floor)", () => {
    const spooledAtMs = 1_000_000;
    expect(computeMinimumReadyAtMs(spooledAtMs, 10, false)).toBeGreaterThan(computeMinimumReadyAtMs(spooledAtMs, 1, false));
  });
});

// Bug this guards against: a 60-page job printed completely but got marked
// print_failed anyway, because the old stuck-job deadline was one fixed
// constant (2 minutes) regardless of page count — a long job's own
// minimum-print-time floor (computeMinimumReadyAtMs) could legitimately
// need longer than that, so it timed out before CUPS ever got a chance to
// report anything wrong. The fix is a single flat 2-hour ceiling, generous
// enough to always clear the floor at any page count this kiosk accepts,
// rather than a per-page formula.
describe("computeStuckJobDeadlineMs", () => {
  it("equals spooledAtMs + STUCK_JOB_TIMEOUT_HOURS, exactly", () => {
    const spooledAtMs = 1_000_000;
    expect(computeStuckJobDeadlineMs(spooledAtMs)).toBe(spooledAtMs + STUCK_JOB_TIMEOUT_HOURS * 60 * 60 * 1000);
  });

  it("for a long (60-page) job, the flat deadline comfortably clears the job's own minimum-print-time floor — the exact bug this fixes", () => {
    const spooledAtMs = 1_000_000;
    const floor = computeMinimumReadyAtMs(spooledAtMs, 60, true);
    expect(computeStuckJobDeadlineMs(spooledAtMs)).toBeGreaterThan(floor);
  });

  it("clears the floor with margin for page counts from 1 to 300 (the kiosk's own max), not just one lucky value", () => {
    const spooledAtMs = 1_000_000;
    const deadline = computeStuckJobDeadlineMs(spooledAtMs);
    for (const physicalSheets of [1, 2, 10, 60, 150, 300]) {
      const floor = computeMinimumReadyAtMs(spooledAtMs, physicalSheets, true);
      expect(deadline).toBeGreaterThan(floor);
    }
  });

  it("is anchored to spooledAtMs, not to when it happens to be called — so a print-agent restart reattaching to an in-progress job computes the exact same deadline a fresh watch of the same job would", () => {
    const spooledAtMs = 1_000_000;
    const freshDeadline = computeStuckJobDeadlineMs(spooledAtMs);
    // Simulates calling this again much later (e.g. after a restart) with
    // the SAME original spooledAtMs — must be identical, not extended.
    const reattachedDeadline = computeStuckJobDeadlineMs(spooledAtMs);
    expect(reattachedDeadline).toBe(freshDeadline);
  });
});

describe("decidePrintWatchOutcome", () => {
  const minimumReadyAtMs = 1_000_000;
  const deadlineMs = 2_000_000;
  const blockedLimitMs = 10_000_000;
  // Most tests below never exercise the blocked path at all — this is the
  // "never been blocked" baseline every one of them starts from, so each
  // test only needs to override what it actually cares about.
  const neverBlocked = { blockedElapsedMs: 0, blockedSinceMs: null, blockedLimitMs };

  it("reports an error immediately, with its reason, even if the floor hasn't elapsed yet", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "error", reason: "jam" }, nowMs: minimumReadyAtMs - 500_000, minimumReadyAtMs, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "error", reason: "jam" });
  });

  it("reports an error even after the deadline has also passed — error still takes priority over timeout", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "error", reason: "jam" }, nowMs: deadlineMs + 1, minimumReadyAtMs, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "error", reason: "jam" });
  });

  it("keeps waiting when CUPS reports completed but the floor hasn't elapsed yet — the exact 'fires too early' bug this guards against", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "completed" }, nowMs: minimumReadyAtMs - 1, minimumReadyAtMs, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "wait" });
  });

  it("is ready the instant both CUPS-completed and the floor are satisfied", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "completed" }, nowMs: minimumReadyAtMs, minimumReadyAtMs, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "ready" });
  });

  it("keeps waiting while still active, before the deadline", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "active" }, nowMs: minimumReadyAtMs, minimumReadyAtMs, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "wait" });
  });

  it("times out once the deadline passes while still only active (never completed)", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "active" }, nowMs: deadlineMs, minimumReadyAtMs, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("times out, not ready, if the floor itself extends past the deadline and CUPS only just completed", () => {
    const outcome = decidePrintWatchOutcome({ cupsState: { kind: "completed" }, nowMs: deadlineMs, minimumReadyAtMs: deadlineMs + 1, deadlineMs, ...neverBlocked });
    expect(outcome).toEqual({ kind: "timeout" });
  });

  describe("blocked (recoverable) problems — paper out during a job", () => {
    it("reports blocked, with its reason, instead of error — never fails the job outright", () => {
      const outcome = decidePrintWatchOutcome({
        cupsState: { kind: "blocked", reason: "media-empty" },
        nowMs: 1_500_000, minimumReadyAtMs, deadlineMs,
        blockedElapsedMs: 0, blockedSinceMs: 1_500_000, blockedLimitMs,
      });
      expect(outcome).toEqual({ kind: "blocked", reason: "media-empty" });
    });

    it("stays blocked even well past the ORIGINAL short deadline — the generous limit is what governs now, not the stuck-job timeout", () => {
      const outcome = decidePrintWatchOutcome({
        cupsState: { kind: "blocked", reason: "media-empty" },
        nowMs: deadlineMs + 1_000_000, minimumReadyAtMs, deadlineMs,
        blockedElapsedMs: 0, blockedSinceMs: deadlineMs, blockedLimitMs,
      });
      expect(outcome).toEqual({ kind: "blocked", reason: "media-empty" });
    });

    it("escalates to blocked_timeout once the SAME blocked spell reaches the generous limit", () => {
      const blockedSinceMs = 1_000_000;
      const outcome = decidePrintWatchOutcome({
        cupsState: { kind: "blocked", reason: "media-empty" },
        nowMs: blockedSinceMs + blockedLimitMs, minimumReadyAtMs, deadlineMs,
        blockedElapsedMs: 0, blockedSinceMs, blockedLimitMs,
      });
      expect(outcome).toEqual({ kind: "blocked_timeout", reason: "media-empty" });
    });
  });

  describe("paper loaded later — the block clears and the job resumes normally", () => {
    it("once CUPS reports completed again, extends the stuck-timeout deadline by exactly the time spent blocked, so the resumed job isn't immediately timed out", () => {
      const blockedElapsedMs = 20 * 60 * 1000; // 20 minutes spent blocked, now resolved
      // Without the extension, nowMs here would already be well past the
      // original deadlineMs — this asserts the extension is what keeps it "ready", not a timeout.
      const nowMs = deadlineMs + blockedElapsedMs - 1;
      const outcome = decidePrintWatchOutcome({
        cupsState: { kind: "completed" },
        nowMs, minimumReadyAtMs, deadlineMs,
        blockedElapsedMs, blockedSinceMs: null, blockedLimitMs,
      });
      expect(outcome).toEqual({ kind: "ready" });
    });

    it("still eventually times out once elapsed time exceeds even the EXTENDED deadline, if the job never actually finishes", () => {
      const blockedElapsedMs = 20 * 60 * 1000;
      const nowMs = deadlineMs + blockedElapsedMs + 1;
      const outcome = decidePrintWatchOutcome({
        cupsState: { kind: "active" },
        nowMs, minimumReadyAtMs, deadlineMs,
        blockedElapsedMs, blockedSinceMs: null, blockedLimitMs,
      });
      expect(outcome).toEqual({ kind: "timeout" });
    });
  });
});
