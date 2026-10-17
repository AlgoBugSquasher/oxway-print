import { describe, expect, it } from "vitest";
import { decideRestartOutcome } from "./restart-reconciliation";

// Requirement #7: "interrupted detection after restart." See
// print-agent/index.ts's reconcileInFlightJobsOnBoot — this is the pure
// decision it makes per in-flight job, pulled out specifically so it can
// be tested without a real CUPS process or database (mirroring how
// decidePrintWatchOutcome in ready-timing.ts is already tested).

describe("decideRestartOutcome", () => {
  it("interrupts a job that never even reached CUPS (no cupsJobId at all) — the agent crashed before submitting it", () => {
    const outcome = decideRestartOutcome({ cupsJobId: undefined, cupsKnowsJob: false });
    expect(outcome).toEqual({ kind: "interrupted", reason: "Print agent restarted before this job was ever submitted to the printer." });
  });

  it("reattaches a job CUPS still has a record of, letting it finish normally", () => {
    const outcome = decideRestartOutcome({ cupsJobId: "oxway-printer-42", cupsKnowsJob: true });
    expect(outcome).toEqual({ kind: "reattach" });
  });

  it("interrupts a job CUPS has genuinely forgotten, naming the lost job id in the reason", () => {
    const outcome = decideRestartOutcome({ cupsJobId: "oxway-printer-42", cupsKnowsJob: false });
    expect(outcome).toEqual({ kind: "interrupted", reason: "Print agent restarted; CUPS had no record of job oxway-printer-42." });
  });

  it("never fails or refunds — every interrupted outcome's reason is purely informational, never 'failed'/'refund'", () => {
    const outcomes = [
      decideRestartOutcome({ cupsJobId: undefined, cupsKnowsJob: false }),
      decideRestartOutcome({ cupsJobId: "oxway-printer-1", cupsKnowsJob: false }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.kind).toBe("interrupted");
      if (outcome.kind === "interrupted") {
        expect(outcome.reason).not.toMatch(/fail|refund/i);
      }
    }
  });
});
