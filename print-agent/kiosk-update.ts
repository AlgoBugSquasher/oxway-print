// Remote "Update kiosk" / "Restart agent" command execution — runs inside
// the main print-agent process (print-agent/index.ts), called once per poll
// tick, only after that tick's paid-job queue has fully drained (see
// index.ts's pollLoop). That ordering is the entire "only update when idle"
// guarantee: the loop is single-threaded and awaits each job to completion
// before ever reaching this call, so there is never a moment where this
// runs while a job is mid-claim or mid-print.
import { execFileSync } from "node:child_process";
import { UPDATE_BRANCH } from "../lib/config";
import { claimPendingKioskCommand, finishKioskCommand, type KioskCommandRecord } from "../lib/kiosk-commands";
import { clearPendingCommandResult, readPendingCommandResult, writePendingCommandResult } from "./pending-command-result";
import { writeUpdateMarker } from "./update-marker";

interface CommandResult {
  ok: boolean;
  error?: string;
}

/** Runs a fixed, hardcoded argv — never a string built from `command.command` or any other database value, so there is no path from a database row to an arbitrary shell command. */
function run(file: string, args: string[]): CommandResult {
  try {
    execFileSync(file, args, { cwd: process.cwd(), stdio: "pipe" });
    return { ok: true };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    const message = stderr || (error instanceof Error ? error.message : String(error));
    return { ok: false, error: message };
  }
}

export function getCurrentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }).toString().trim();
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Reports a command's already-decided outcome to Supabase, falling back to
 * local disk (print-agent/pending-command-result.ts) if that write itself
 * fails — e.g. the Pi's own network dropped in the same instant the git
 * pull/npm install failure was detected. Without this fallback, the
 * kiosk_commands row would be stranded at "running" forever, since nothing
 * else ever revisits a row that isn't "pending".
 */
async function reportOutcome(commandId: string, status: "done" | "failed", result: string): Promise<void> {
  try {
    await finishKioskCommand(commandId, status, result);
  } catch (error) {
    console.error(`[print-agent] Could not report kiosk command ${commandId} outcome (will retry next tick):`, error);
    writePendingCommandResult({ commandId, status, result });
  }
}

/**
 * Retries flushing a previous tick's stranded report (see reportOutcome
 * above) before doing anything else this tick — called unconditionally,
 * not just when a new command is pending, since the two are independent.
 * Also called once at startup (print-agent/index.ts's reportBoot) before
 * the dangling-"running"-row cleanup runs, so a stranded report from
 * before a restart gets first crack at landing its real outcome rather
 * than being overwritten by that cleanup's generic "interrupted" message.
 */
export async function flushPendingResult(): Promise<void> {
  const pending = readPendingCommandResult();
  if (!pending) return;
  try {
    await finishKioskCommand(pending.commandId, pending.status, pending.result);
    clearPendingCommandResult();
  } catch {
    // Still down — leave it for the next tick, same as before.
  }
}

/**
 * Checks for and, if idle, runs the next pending command for this kiosk.
 * No-op if there's nothing pending — the common case on almost every tick.
 *
 * Maps the whitelisted `command.command` value to exactly one of two fixed
 * code paths below, never anything derived from the database row itself.
 */
export async function processKioskCommand(kioskId: string): Promise<void> {
  await flushPendingResult();

  const command = await claimPendingKioskCommand(kioskId);
  if (!command) return;

  if (command.command === "restart") {
    await runRestart(command);
    return;
  }
  await runUpdate(command);
}

/**
 * No code changes involved, so no rollback risk — mark done immediately
 * (optimistic: we're confident the already-running, already-proven code
 * will come back, since nothing about it is changing) and exit for
 * systemd's Restart= to bring the same code straight back up.
 */
async function runRestart(command: KioskCommandRecord): Promise<void> {
  await reportOutcome(command.id, "done", "Restarted.");
  console.log(`[print-agent] Restart command received for ${command.id} — exiting for systemd to restart us.`);
  process.exit(0);
}

/**
 * Fast-forward-only pull of UPDATE_BRANCH (this Pi's own env config, never
 * the command row — see lib/config.ts's UPDATE_BRANCH comment) + npm
 * install. Either step failing rolls back to the commit recorded before
 * anything was touched and keeps running the current, already-loaded old
 * code (no restart needed — the files are back to matching what's already
 * in memory). Only once BOTH steps succeed does this write the verification
 * marker and restart — see print-agent/boot-guard.ts for what happens next.
 */
async function runUpdate(command: KioskCommandRecord): Promise<void> {
  const previousCommit = getCurrentCommit();

  const fetchResult = run("git", ["fetch", "origin", UPDATE_BRANCH]);
  const pullResult = fetchResult.ok
    ? run("git", ["merge", "--ff-only", `origin/${UPDATE_BRANCH}`])
    : fetchResult;
  if (!pullResult.ok) {
    await reportOutcome(command.id, "failed", `git pull failed: ${pullResult.error}`);
    return;
  }

  const installResult = run("npm", ["install"]);
  if (!installResult.ok) {
    run("git", ["reset", "--hard", previousCommit]);
    run("npm", ["install"]); // Best-effort restore of node_modules to match the reverted commit; its own failure is logged but not fatal here.
    await reportOutcome(command.id, "failed", `npm install failed after pulling the update — rolled back to ${shortCommit(previousCommit)}: ${installResult.error}`);
    return;
  }

  // Both succeeded, but that only proves the new code is *present*, not that
  // it actually runs — leave the command "running" (not "done" yet) and let
  // the post-restart boot sequence confirm or roll back and finalize it.
  writeUpdateMarker({ commandId: command.id, previousCommit, status: "verifying" });
  console.log(`[print-agent] Pulled and installed the latest ${UPDATE_BRANCH} (${shortCommit(getCurrentCommit())}) — restarting to verify it comes up cleanly...`);
  process.exit(0);
}
