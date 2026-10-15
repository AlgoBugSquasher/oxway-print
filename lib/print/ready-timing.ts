/**
 * The minimum-print-time floor: a job is never marked "printed" purely
 * because CUPS (and the printer itself) say the job is done — see
 * lib/print/cups.ts's getCupsJobQueueState for why even that signal alone
 * isn't fully trustworthy for a multi-copy job buffered on the printer's own
 * hardware. This file adds an independent, elapsed-time safety net on top of
 * it: physically, a job cannot be finished before it could plausibly have
 * finished, so "printed" waits for whichever of (CUPS-completed, the floor)
 * is slower.
 */

export const READY_TIMING_CONFIG = {
  /** Seconds a single physical sheet takes to print, for the floor's own estimate. Tune against the real printer if it runs consistently faster/slower. */
  secPerPageSeconds: 3.5,
  /** Extra cushion added on top of the raw sheets x secPerPageSeconds estimate, to absorb normal jitter without needing to be exact. */
  graceSeconds: 2,
  /** Extra time added only when the printer was idle for a while before this job (see needsWarmup) — a cold printer's first page is slower than its others. */
  warmupSeconds: 10,
  /** How long the printer must have been idle before this job for warmupSeconds to apply. */
  warmupIdleThresholdSeconds: 120,
} as const;

/**
 * True if the printer had been sitting idle long enough before this job
 * started that its first page should be assumed slower (see
 * READY_TIMING_CONFIG.warmupSeconds). `lastJobFinishedAtMs` is null for the
 * agent's very first job since its own process started — treated as "needs
 * warmup," since an agent restart tells us nothing about how long the
 * printer was actually idle before that.
 */
export function needsWarmup(claimedAtMs: number, lastJobFinishedAtMs: number | null): boolean {
  if (lastJobFinishedAtMs === null) return true;
  const idleSeconds = (claimedAtMs - lastJobFinishedAtMs) / 1000;
  return idleSeconds >= READY_TIMING_CONFIG.warmupIdleThresholdSeconds;
}

/**
 * The earliest instant a job could genuinely be done, given when it was
 * spooled to CUPS and how many physical sheets it will print (banner
 * included — see physicalSheetsForJob, which this is meant to be called
 * with). "Printed" must never fire before this, however early CUPS/the
 * printer claim to be done.
 */
export function computeMinimumReadyAtMs(spooledAtMs: number, physicalSheets: number, warmupNeeded: boolean): number {
  const printSeconds = physicalSheets * READY_TIMING_CONFIG.secPerPageSeconds;
  const warmup = warmupNeeded ? READY_TIMING_CONFIG.warmupSeconds : 0;
  return spooledAtMs + (printSeconds + READY_TIMING_CONFIG.graceSeconds + warmup) * 1000;
}

export type CupsWatchState = "active" | "completed" | "error";

export type PrintWatchOutcome =
  | { kind: "error" }
  | { kind: "wait" }
  | { kind: "ready" }
  | { kind: "timeout" };

/**
 * One tick's worth of decision logic for print-agent/index.ts's
 * watchUntilPrinted — pulled out as a pure function so the floor/warm-up/
 * error-priority rules can be tested directly, without a test harness for
 * the agent's actual polling loop. An "error" from CUPS always wins
 * immediately, even if the floor hasn't elapsed yet — a paper jam doesn't
 * get more plausible by waiting for it. Otherwise, "ready" requires BOTH
 * cupsState === "completed" AND the elapsed-time floor to have passed;
 * anything else (including "completed" too early) is "wait" until the
 * overall deadline, which is reported as "timeout".
 */
export function decidePrintWatchOutcome(input: {
  cupsState: CupsWatchState;
  nowMs: number;
  minimumReadyAtMs: number;
  deadlineMs: number;
}): PrintWatchOutcome {
  if (input.cupsState === "error") return { kind: "error" };
  if (input.cupsState === "completed" && input.nowMs >= input.minimumReadyAtMs) return { kind: "ready" };
  if (input.nowMs >= input.deadlineMs) return { kind: "timeout" };
  return { kind: "wait" };
}
