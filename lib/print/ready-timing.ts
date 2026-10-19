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
  /**
   * How long a RECOVERABLE printer problem (out of paper, door open, low
   * toner, offline — see lib/print/cups.ts's classification) is tolerated
   * before a job is finally marked print_failed. Deliberately generous and
   * separate from the normal "stuck" deadline (computeStuckJobDeadlineMs
   * below) — that one assumes something is genuinely wedged; this one
   * assumes a person needs to notice the kiosk and physically go fix it,
   * which can reasonably take a
   * while on an unattended machine. 30 minutes: long enough for "nobody's
   * standing next to it right now," short enough that a job that's
   * genuinely never coming back still resolves (and its refund queues up)
   * within the same business day.
   */
  blockedRetryLimitSeconds: 30 * 60,
} as const;

/**
 * The "genuinely stuck" deadline — the outer ceiling on a job's whole time
 * from spool to print, regardless of page count. One flat 2-hour window,
 * not scaled per page: at this kiosk's own page limit (300 sheets,
 * lib/config.ts's MAX_UPLOAD_PAGE_COUNT), the minimum-print-time floor
 * above (computeMinimumReadyAtMs) only ever needs on the order of 20
 * minutes — 2 hours clears that with enormous room to spare for any job
 * this kiosk can actually accept, so there's no need for a per-page
 * formula to avoid the original bug (a job that printed completely but
 * got marked print_failed because a fixed, too-SHORT timeout didn't scale
 * with page count). Once this deadline passes, the job is stuck for real.
 */
export const STUCK_JOB_TIMEOUT_HOURS = 2;

/**
 * Anchored to `spooledAtMs` (when this job was actually submitted to CUPS),
 * never to "now" — so a print-agent restart that reattaches to an
 * in-progress job (print-agent/index.ts's reconcileInFlightJobsOnBoot)
 * computes the exact same deadline a fresh, never-restarted watch of the
 * same job would have, rather than quietly granting it a fresh full
 * timeout window from the moment of the restart.
 */
export function computeStuckJobDeadlineMs(spooledAtMs: number): number {
  return spooledAtMs + STUCK_JOB_TIMEOUT_HOURS * 60 * 60 * 1000;
}

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

/**
 * What CUPS (+the printer) reported this tick — see lib/print/cups.ts's
 * getCupsJobQueueState for exactly how each is detected. "blocked" is new:
 * a RECOVERABLE problem (out of paper, door open, low toner, offline) that
 * must never fail the job outright — see decidePrintWatchOutcome below.
 * "error" stays reserved for something no amount of waiting fixes (a jam,
 * an explicit cancel/abort, or anything CUPS has already moved to its
 * terminal completed-job history, however it got there).
 */
export type CupsWatchState =
  | { kind: "active" }
  | { kind: "completed" }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; reason: string };

export type PrintWatchOutcome =
  | { kind: "error"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "wait" }
  | { kind: "ready" }
  | { kind: "timeout" }
  /** The SAME recoverable problem (or a run of them) has now lasted past READY_TIMING_CONFIG.blockedRetryLimitSeconds — time to finally give up and fail the job. */
  | { kind: "blocked_timeout"; reason: string };

/**
 * One tick's worth of decision logic for print-agent/index.ts's print loop
 * — pulled out as a pure function so the floor/warm-up/blocked-vs-error
 * priority rules can be tested directly, without a test harness for the
 * agent's actual polling loop.
 *
 * An "error" from CUPS always wins immediately, even if the floor hasn't
 * elapsed yet — a paper jam doesn't get more plausible by waiting for it.
 * A "blocked" state never fails the job by itself — it's reported back so
 * the caller can mark the job print_blocked (and, critically, never
 * cancels the live CUPS job — see print-agent/index.ts's own comment on
 * why that's exactly what lets the SAME job finish on its own once the
 * printer's ready again) — UNLESS blockedSinceMs shows the SAME blocked
 * spell has already run for blockedLimitMs or more, in which case this
 * finally reports "blocked_timeout" so the caller can give up.
 *
 * blockedElapsedMs (total time already spent blocked earlier in THIS
 * job's life, accumulated by the caller across however many separate
 * blocked spells there were) is added on top of deadlineMs before
 * comparing against it — time spent legitimately waiting on paper must
 * never count against the ordinary "stuck" timeout, or a job blocked for
 * 10 minutes would immediately "time out" the instant it resumed, even
 * though it was never actually stuck in the sense that deadline exists to
 * catch.
 */
export function decidePrintWatchOutcome(input: {
  cupsState: CupsWatchState;
  nowMs: number;
  minimumReadyAtMs: number;
  deadlineMs: number;
  /** Total ms already spent blocked earlier in this job's life (0 if it's never been blocked before). */
  blockedElapsedMs: number;
  /** When the CURRENT blocked spell started, or null if cupsState isn't "blocked" right now. */
  blockedSinceMs: number | null;
  blockedLimitMs: number;
}): PrintWatchOutcome {
  if (input.cupsState.kind === "error") return { kind: "error", reason: input.cupsState.reason };

  if (input.cupsState.kind === "blocked") {
    const blockedForMs = input.blockedSinceMs !== null ? input.nowMs - input.blockedSinceMs : 0;
    if (blockedForMs >= input.blockedLimitMs) return { kind: "blocked_timeout", reason: input.cupsState.reason };
    return { kind: "blocked", reason: input.cupsState.reason };
  }

  if (input.cupsState.kind === "completed" && input.nowMs >= input.minimumReadyAtMs) return { kind: "ready" };
  const effectiveDeadlineMs = input.deadlineMs + input.blockedElapsedMs;
  if (input.nowMs >= effectiveDeadlineMs) return { kind: "timeout" };
  return { kind: "wait" };
}
