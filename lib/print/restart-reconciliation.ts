/**
 * Pure decision logic for print-agent/index.ts's reconcileInFlightJobsOnBoot
 * — pulled out specifically so "interrupted detection after restart" can be
 * unit-tested directly, the same way decidePrintWatchOutcome in
 * ready-timing.ts is, without needing a real CUPS process or database.
 */
export type RestartJobOutcome =
  | { kind: "reattach" }
  | { kind: "interrupted"; reason: string };

/**
 * `cupsJobId` is undefined when the agent crashed before this job was
 * ever submitted to CUPS at all — there's nothing for isCupsJobKnown
 * (lib/print/cups.ts) to even ask about, so this is interrupted
 * unconditionally, no CUPS call needed. Otherwise, `cupsKnowsJob` is
 * whatever isCupsJobKnown returned — true means CUPS still has some
 * record of the job (reattach the normal watch loop and let it resolve
 * on its own); false means CUPS has genuinely forgotten it (mark
 * interrupted, with a reason naming the lost job id for later diagnosis).
 */
export function decideRestartOutcome(input: { cupsJobId: string | undefined; cupsKnowsJob: boolean }): RestartJobOutcome {
  if (!input.cupsJobId) {
    return { kind: "interrupted", reason: "Print agent restarted before this job was ever submitted to the printer." };
  }
  if (input.cupsKnowsJob) {
    return { kind: "reattach" };
  }
  return { kind: "interrupted", reason: `Print agent restarted; CUPS had no record of job ${input.cupsJobId}.` };
}
