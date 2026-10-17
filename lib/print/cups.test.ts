import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrintSettingsSnapshot } from "../store";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/**
 * One queued `lpstat`/`cancel` response per expected call, consumed in
 * order — simpler than pattern-matching on args, and the exact sequence
 * getCupsJobQueueState makes (active lpstat, then maybe completed lpstat,
 * then maybe isPrinterIdle's lpstat -p) is itself part of what each test
 * below is asserting.
 *
 * Must carry the SAME `util.promisify.custom` symbol Node's real
 * child_process.execFile defines — cups.ts calls `promisify(execFile)`
 * once at module load, and without that symbol, generic `promisify()`
 * assumes a plain single-value `(err, value)` callback and resolves to
 * just the raw `stdout` string argument, not `{stdout, stderr}` — which
 * then makes every `const { stdout } = await execFileAsync(...)` in
 * cups.ts destructure `undefined`, silently swallowed by that file's own
 * catch-and-return-[]/false fallbacks. Confirmed the hard way: every test
 * below read back "active"/true regardless of what was queued until this
 * was added.
 */
const mockExecFile = vi.hoisted(() => {
  const queue: { stdout?: string; error?: Error }[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const fn = vi.fn((cmd: string, args: string[], callback: ExecFileCallback) => {
    calls.push({ cmd, args });
    const next = queue.shift();
    if (!next) return callback(new Error(`no mock response queued for execFile(${cmd}, ${JSON.stringify(args)})`), "", "");
    if (next.error) return callback(next.error, "", "");
    callback(null, next.stdout ?? "", "");
  });
  // Attached to the SPY itself (not some inner, un-wrapped function) —
  // promisify(execFile) in cups.ts calls promisify on whatever this mock
  // module exports as `execFile`, which is this exact object. The well-known
  // global symbol key is used directly (Symbol.for, not an imported
  // `util.promisify.custom`) specifically so this works from inside
  // vi.hoisted, which runs before this file's own imports are initialized.
  (fn as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      fn(cmd, args, (error: Error | null, stdout: string, stderr: string) => (error ? reject(error) : resolve({ stdout, stderr })));
    });
  return { queue, calls, fn };
});

vi.mock("node:child_process", () => ({ execFile: mockExecFile.fn }));

import { buildLpArgs, classifyPrinterProblemText, getCupsJobQueueState, isPrinterAcceptingNewJobs } from "./cups";

beforeEach(() => {
  mockExecFile.queue.length = 0;
  mockExecFile.calls.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

// Direct, deterministic assertions on the exact `lp` arguments built for a
// given settings combination — catches an accidental change to any of
// these -o options (fit-to-page, media, number-up, print-color-mode) or to
// the always-one-copy contract, without needing to mock execFile/lp.

function settings(overrides: Partial<PrintSettingsSnapshot> = {}): PrintSettingsSnapshot {
  return {
    copies: 1,
    layout: "portrait",
    isColor: false,
    paperSize: "A4",
    pagesPerSheet: 1,
    ...overrides,
  };
}

describe("buildLpArgs", () => {
  it("builds the baseline B&W A4 single-up args", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings())).toEqual([
      "-n", "1",
      "-o", "media=a4",
      "-o", "number-up=1",
      "-o", "fit-to-page",
      "-o", "print-color-mode=monochrome",
      "/tmp/job.pdf",
    ]);
  });

  it("always submits exactly one CUPS-level copy, regardless of the job's own copies setting — copies are baked into the PDF before this is ever called", () => {
    for (const copies of [1, 2, 5]) {
      const args = buildLpArgs("/tmp/job.pdf", settings({ copies }));
      expect(args[0]).toBe("-n");
      expect(args[1]).toBe("1");
    }
  });

  it("never sets orientation-requested — content geometry alone decides orientation (see lib/print/pdf.ts)", () => {
    for (const layout of ["portrait", "landscape"] as const) {
      const args = buildLpArgs("/tmp/job.pdf", settings({ layout }));
      expect(args).not.toContain("orientation-requested");
      expect(args.some((arg) => arg.startsWith("orientation-requested"))).toBe(false);
    }
  });

  it("maps paperSize to the right media option", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize: "A4" }))).toContain("media=a4");
    expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize: "Letter" }))).toContain("media=letter");
    expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize: "Legal" }))).toContain("media=legal");
  });

  it("maps pagesPerSheet to number-up", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ pagesPerSheet: 1 }))).toContain("number-up=1");
    expect(buildLpArgs("/tmp/job.pdf", settings({ pagesPerSheet: 2 }))).toContain("number-up=2");
    expect(buildLpArgs("/tmp/job.pdf", settings({ pagesPerSheet: 4 }))).toContain("number-up=4");
  });

  it("maps isColor to print-color-mode", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ isColor: false }))).toContain("print-color-mode=monochrome");
    expect(buildLpArgs("/tmp/job.pdf", settings({ isColor: true }))).toContain("print-color-mode=color");
  });

  it("always includes fit-to-page, unconditionally", () => {
    for (const paperSize of ["A4", "Letter", "Legal"] as const) {
      expect(buildLpArgs("/tmp/job.pdf", settings({ paperSize }))).toContain("fit-to-page");
    }
  });

  it("appends the file path last", () => {
    const args = buildLpArgs("/tmp/some/job-42.pdf", settings());
    expect(args.at(-1)).toBe("/tmp/some/job-42.pdf");
  });

  it("builds the exact args for a full non-default combination (color, Letter, 4-up)", () => {
    expect(buildLpArgs("/tmp/job.pdf", settings({ isColor: true, paperSize: "Letter", pagesPerSheet: 4, copies: 3 }))).toEqual([
      "-n", "1",
      "-o", "media=letter",
      "-o", "number-up=4",
      "-o", "fit-to-page",
      "-o", "print-color-mode=color",
      "/tmp/job.pdf",
    ]);
  });
});

describe("classifyPrinterProblemText", () => {
  it("classifies every documented recoverable condition as 'blocked'", () => {
    for (const text of ["Unable to print: media-empty", "media needed", "out of paper", "front door open", "toner low", "printer is offline", "not connected"]) {
      expect(classifyPrinterProblemText(text)).toBe("blocked");
    }
  });

  it("classifies every documented unrecoverable condition as 'error'", () => {
    for (const text of ["paper jam detected", "job aborted", "job canceled"]) {
      expect(classifyPrinterProblemText(text)).toBe("error");
    }
  });

  it("resolves an ambiguous message mentioning both a recoverable and unrecoverable word to 'error' — a jam is never safe to just wait out", () => {
    expect(classifyPrinterProblemText("canceled due to media jam")).toBe("error");
  });

  it("does NOT classify a bare 'stopped'/'held' as unrecoverable — CUPS uses both generically for a backend auto-pausing itself after repeated errors, which is just as often a recoverable paper/toner condition as a genuine failure; treating it as an automatic 'error' would silently reintroduce the exact double-outcome bug this classification exists to prevent", () => {
    expect(classifyPrinterProblemText("printer stopped")).toBeNull();
    expect(classifyPrinterProblemText("job held")).toBeNull();
  });

  it("still classifies correctly when 'stopped'/'held' appears ALONGSIDE a real, specific reason", () => {
    expect(classifyPrinterProblemText("Printer stopped due to media-empty")).toBe("blocked");
    expect(classifyPrinterProblemText("Job held: paper jam")).toBe("error");
  });

  it("returns null (no problem detected) for an ordinary, healthy status line", () => {
    expect(classifyPrinterProblemText("Samsung_ML_1865_Series-42 owner 1024 completed")).toBeNull();
  });
});

describe("getCupsJobQueueState", () => {
  const cupsJobId = "Samsung_ML_1865_Series-42";

  it("reports 'active' when the job is in the queue with no problem text", async () => {
    mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 queued for printing\n` });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state).toEqual({ kind: "active" });
  });

  it("paper out during a job: an active job whose detail line mentions media-empty is reported 'blocked', with the reason, never cancelled or failed", async () => {
    mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 Tue 14 Oct 2025 10:00:00 AM IST\n\tUnable to print: media-empty\n` });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state).toEqual({ kind: "blocked", reason: "media-empty" });
  });

  it("an active job whose detail line mentions a jam is reported 'error', with the reason", async () => {
    mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 Tue 14 Oct 2025 10:00:00 AM IST\n\tPaper jam in tray 1\n` });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state).toEqual({ kind: "error", reason: "jam" });
  });

  it("word-boundary: a job id that's a PREFIX of another job's id in the same listing is never confused with it", async () => {
    // "Samsung_ML_1865_Series-1" must not match "Samsung_ML_1865_Series-10"'s own header line.
    mockExecFile.queue.push({
      stdout: "Samsung_ML_1865_Series-10 owner 1024 Tue 14 Oct 2025 10:05:00 AM IST\n\tUnable to print: media-empty\n",
    });
    // Nothing for "-1" in the active list -> falls through to the completed check.
    mockExecFile.queue.push({ stdout: "" });
    const state = await getCupsJobQueueState("Samsung_ML_1865_Series-1");
    expect(state).toEqual({ kind: "active" }); // not found anywhere -> active, NOT misread as job -10's own "blocked" state
  });

  it("a canceled/aborted job already in CUPS's completed history is 'error', even though 'canceled' alone would be recoverable-shaped if it were still active", async () => {
    mockExecFile.queue.push({ stdout: "" }); // not in the active list
    mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 Tue 14 Oct 2025 10:00:00 AM IST\n\tJob completed with status: canceled\n` });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state.kind).toBe("error");
  });

  it("is 'completed' once found clean in history AND the printer itself reports idle", async () => {
    mockExecFile.queue.push({ stdout: "" });
    mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 completed\n` });
    mockExecFile.queue.push({ stdout: "printer Samsung_ML_1865_Series is idle.  enabled since Tue 14 Oct 2025 10:00:00 AM IST\n" });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state).toEqual({ kind: "completed" });
  });

  it("stays 'active' if found clean in history but the printer is still physically busy (multi-copy buffering)", async () => {
    mockExecFile.queue.push({ stdout: "" });
    mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 completed\n` });
    mockExecFile.queue.push({ stdout: `printer Samsung_ML_1865_Series now printing ${cupsJobId}.\n` });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state).toEqual({ kind: "active" });
  });

  it("is 'active', never a guessed 'completed', when the job isn't found in either list at all", async () => {
    mockExecFile.queue.push({ stdout: "" });
    mockExecFile.queue.push({ stdout: "" });
    const state = await getCupsJobQueueState(cupsJobId);
    expect(state).toEqual({ kind: "active" });
  });

  describe("paper loaded later — the block clears on its own", () => {
    it("the SAME job, polled again after paper is loaded, now reports completed — no resubmission needed", async () => {
      // First poll: blocked.
      mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 Tue 14 Oct 2025 10:00:00 AM IST\n\tUnable to print: media-empty\n` });
      const firstPoll = await getCupsJobQueueState(cupsJobId);
      expect(firstPoll).toEqual({ kind: "blocked", reason: "media-empty" });

      // Second poll, after paper was loaded: the job has left the active
      // queue and finished printing on its own.
      mockExecFile.queue.push({ stdout: "" });
      mockExecFile.queue.push({ stdout: `${cupsJobId} owner 1024 completed\n` });
      mockExecFile.queue.push({ stdout: "printer Samsung_ML_1865_Series is idle.  enabled since Tue 14 Oct 2025 10:10:00 AM IST\n" });
      const secondPoll = await getCupsJobQueueState(cupsJobId);
      expect(secondPoll).toEqual({ kind: "completed" });
    });
  });
});

describe("isPrinterAcceptingNewJobs", () => {
  it("reports false when lpstat shows the printer disabled", async () => {
    mockExecFile.queue.push({ stdout: "printer Samsung_ML_1865_Series disabled since Tue 14 Oct 2025 10:00:00 AM IST -\n\treason unknown\n" });
    await expect(isPrinterAcceptingNewJobs()).resolves.toBe(false);
  });

  it("reports true when lpstat shows the printer idle/enabled", async () => {
    mockExecFile.queue.push({ stdout: "printer Samsung_ML_1865_Series is idle.  enabled since Tue 14 Oct 2025 10:00:00 AM IST\n" });
    await expect(isPrinterAcceptingNewJobs()).resolves.toBe(true);
  });

  it("fails OPEN (reports true) if lpstat itself can't be reached — never blocks submission on an unrelated CLI failure alone", async () => {
    mockExecFile.queue.push({ error: new Error("command not found") });
    await expect(isPrinterAcceptingNewJobs()).resolves.toBe(true);
  });
});
