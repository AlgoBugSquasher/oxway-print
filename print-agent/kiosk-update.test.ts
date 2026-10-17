import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  execResults: new Map<string, { ok: boolean; error?: string }>(),
  execCalls: [] as string[],
  finishCalls: [] as { commandId: string; status: string; result: string }[],
  markerWrites: [] as unknown[],
  exitCalls: [] as (number | undefined)[],
}));

vi.mock("node:child_process", () => ({
  execFileSync: (file: string, args: string[]) => {
    const key = `${file} ${args.join(" ")}`;
    mock.execCalls.push(key);
    const result = mock.execResults.get(key) ?? { ok: true };
    if (!result.ok) {
      const error = new Error(result.error ?? "command failed") as Error & { stderr?: Buffer };
      error.stderr = Buffer.from(result.error ?? "command failed");
      throw error;
    }
    if (file === "git" && args[0] === "rev-parse") return Buffer.from("deadbeef1234567890\n");
    return Buffer.from("");
  },
}));

vi.mock("../lib/config", () => ({ UPDATE_BRANCH: "main" }));

vi.mock("../lib/kiosk-commands", () => ({
  claimPendingKioskCommand: vi.fn(),
  finishKioskCommand: (commandId: string, status: string, result: string) => {
    mock.finishCalls.push({ commandId, status, result });
    return Promise.resolve();
  },
}));

vi.mock("./pending-command-result", () => ({
  clearPendingCommandResult: vi.fn(),
  readPendingCommandResult: () => null,
  writePendingCommandResult: vi.fn(),
}));

vi.mock("./update-marker", () => ({
  writeUpdateMarker: (marker: unknown) => mock.markerWrites.push(marker),
}));

function setExecResult(command: string, result: { ok: boolean; error?: string }) {
  mock.execResults.set(command, result);
}

describe("runUpdate (print-agent/kiosk-update.ts)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mock.execResults.clear();
    mock.execCalls = [];
    mock.finishCalls = [];
    mock.markerWrites = [];
    mock.exitCalls = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      mock.exitCalls.push(code);
      throw new Error("process.exit called"); // stops execution like the real exit would
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("clean update: fetches then hard-resets to origin/<branch> — never git pull or git merge", async () => {
    const { processKioskCommand } = await import("./kiosk-update");
    const { claimPendingKioskCommand } = await import("../lib/kiosk-commands");
    (claimPendingKioskCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "cmd-1", kioskId: "oxway_01", command: "update" });

    await expect(processKioskCommand("oxway_01")).rejects.toThrow("process.exit called");

    expect(mock.execCalls).toContain("git fetch origin main");
    expect(mock.execCalls).toContain("git reset --hard origin/main");
    expect(mock.execCalls).toContain("npm ci");
    expect(mock.execCalls.some((c) => c.includes("pull") || c.includes("merge"))).toBe(false);
    expect(mock.markerWrites).toHaveLength(1);
    expect(mock.exitCalls).toEqual([0]);
  });

  it("a dirty package-lock.json on the Pi no longer breaks the update — reset --hard discards it instead of refusing like git pull would", async () => {
    // Nothing to mock specially: git reset --hard has no "local changes
    // would be overwritten" failure mode at all, unlike git pull/merge —
    // this test documents that by asserting reset (not pull/merge) is the
    // only git write path ever used, same assertion as the test above.
    const { processKioskCommand } = await import("./kiosk-update");
    const { claimPendingKioskCommand } = await import("../lib/kiosk-commands");
    (claimPendingKioskCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "cmd-2", kioskId: "oxway_01", command: "update" });

    await expect(processKioskCommand("oxway_01")).rejects.toThrow("process.exit called");

    expect(mock.execCalls).toContain("git reset --hard origin/main");
    expect(mock.finishCalls).toHaveLength(0); // still "running" — confirmBootIfPending finishes it after restart
  });

  it("npm ci failure rolls back to the previous commit and reports failed", async () => {
    setExecResult("npm ci", { ok: false, error: "npm ci failed: lockfile out of date" });
    const { processKioskCommand } = await import("./kiosk-update");
    const { claimPendingKioskCommand } = await import("../lib/kiosk-commands");
    (claimPendingKioskCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "cmd-3", kioskId: "oxway_01", command: "update" });

    await processKioskCommand("oxway_01");

    expect(mock.execCalls).toContain("git reset --hard deadbeef1234567890");
    expect(mock.execCalls.filter((c) => c === "npm ci")).toHaveLength(2); // the failed attempt + the rollback reinstall
    expect(mock.finishCalls).toHaveLength(1);
    expect(mock.finishCalls[0].status).toBe("failed");
    expect(mock.finishCalls[0].result).toContain("rolled back");
    expect(mock.markerWrites).toHaveLength(0);
    expect(mock.exitCalls).toHaveLength(0); // never exits — the old, already-loaded code just keeps running
  });

  it("git reset failure reports failed without attempting any rollback (nothing moved yet)", async () => {
    setExecResult("git reset --hard origin/main", { ok: false, error: "fatal: unable to resolve reference" });
    const { processKioskCommand } = await import("./kiosk-update");
    const { claimPendingKioskCommand } = await import("../lib/kiosk-commands");
    (claimPendingKioskCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "cmd-4", kioskId: "oxway_01", command: "update" });

    await processKioskCommand("oxway_01");

    expect(mock.execCalls.filter((c) => c === "npm ci")).toHaveLength(0);
    expect(mock.finishCalls[0].status).toBe("failed");
    expect(mock.finishCalls[0].result).toContain("git reset");
  });
});
