/**
 * Entry point systemd actually runs (see pi/oxway-print-agent.service and
 * package.json's "print-agent" script) — spawns the real agent
 * (print-agent/index.ts) as a child process and, ONLY right after an
 * `update` command just restarted into new code, watches it come up and
 * rolls back automatically if it doesn't.
 *
 * Why this needs to be a separate process at all, not just logic inside
 * index.ts: if a bad update breaks something index.ts imports (a syntax
 * error, a top-level throw in a lib/ file), `tsx print-agent/index.ts`
 * itself fails before a single line of index.ts's own body ever runs — no
 * code living inside that file could ever detect or react to its own
 * failure to even load. Something has to sit outside that process
 * entirely. This file is deliberately that "something," and deliberately
 * tiny and dependency-free (only Node's own child_process, plus
 * update-marker.ts, which is itself dependency-free — see its own
 * docstring) specifically so that *this* file stays safe to run regardless
 * of how badly a bad update broke everything else in the repo.
 *
 * The rollback design, and why it's this and not something fancier:
 *   1. Before restarting into pulled code, kiosk-update.ts writes a marker
 *      file (print-agent/update-marker.ts) recording the previous commit
 *      and status "verifying".
 *   2. This file sees that marker at spawn time and watches two things at
 *      once for up to VERIFY_TIMEOUT_MS: does the child process exit
 *      (crash), and does the marker change (index.ts clears it once it's
 *      completed a full, successful poll cycle — see confirmBootIfPending
 *      in index.ts — which is reasonably strong evidence the new code
 *      actually works, not just that it parsed).
 *   3. If the child crashes, or the marker is still "verifying" once the
 *      timeout elapses (a hang, not a crash), this treats the update as
 *      failed: `git reset --hard` to the recorded previous commit, `npm
 *      install` to match, write the marker to "rolled_back", and exit
 *      non-zero so systemd's own Restart=always (already in the unit file)
 *      brings up a fresh boot-guard — which this time finds no "verifying"
 *      marker, so it just launches normally, no special monitoring.
 *   4. The *next* boot of the real agent (now back on the old, known-good
 *      commit) sees the "rolled_back" marker at its own startup and is the
 *      one that actually reports the command as `failed` to Supabase (see
 *      index.ts) — boot-guard itself never talks to Supabase, on purpose,
 *      to keep it free of any dependency that a bad update could break.
 *
 * Known, accepted gap: if an update somehow corrupts THIS specific file
 * (or breaks `tsx`/Node itself), no software-only recovery is possible —
 * that's a genuine edge case for a kiosk evaluator-grade build, not
 * something worth a second, independent watchdog process to guard against.
 */
import { execFileSync, spawn } from "node:child_process";
import { readUpdateMarker, writeUpdateMarker, type UpdateMarker } from "./update-marker";

const VERIFY_TIMEOUT_MS = 45_000;
const MARKER_POLL_INTERVAL_MS = 1_000;

function rollback(marker: UpdateMarker): void {
  console.error(`[boot-guard] Rolling back to ${marker.previousCommit.slice(0, 7)}...`);
  try {
    execFileSync("git", ["reset", "--hard", marker.previousCommit], { cwd: process.cwd(), stdio: "pipe" });
    execFileSync("npm", ["install"], { cwd: process.cwd(), stdio: "pipe" });
  } catch (error) {
    console.error("[boot-guard] Rollback itself failed — manual intervention needed on this Pi:", error);
  }
  // Written regardless of whether npm install above fully succeeded — this
  // marker's only remaining job is telling the next boot "report the
  // original command as failed," which is true either way.
  writeUpdateMarker({ ...marker, status: "rolled_back" });
}

function main(): void {
  const marker = readUpdateMarker();
  const isVerifyingAnUpdate = marker?.status === "verifying";

  // Pi-only (see print-agent/index.ts's own top-of-file note) — `npx` is
  // fine unlike on Windows dev machines, which this file never runs on.
  const child = spawn("npx", ["tsx", "print-agent/index.ts"], { cwd: process.cwd(), stdio: "inherit" });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));

  if (!isVerifyingAnUpdate || !marker) {
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  let settled = false;

  const pollTimer = setInterval(() => {
    const current = readUpdateMarker();
    if (current && current.status === "verifying") return; // Still waiting.
    // index.ts cleared (or otherwise changed) the marker itself — it
    // reached a confirmed-healthy state on its own. Stop the special
    // watch and fall back to plain pass-through supervision for the rest
    // of this process's life, same as the no-update-in-progress path above.
    settled = true;
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    child.on("exit", (code) => process.exit(code ?? 1));
  }, MARKER_POLL_INTERVAL_MS);

  const timeoutTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    clearInterval(pollTimer);
    console.error(`[boot-guard] New version never confirmed within ${VERIFY_TIMEOUT_MS / 1000}s — treating as a hang.`);
    child.kill("SIGTERM");
    rollback(marker);
    process.exit(1);
  }, VERIFY_TIMEOUT_MS);

  child.on("exit", (code) => {
    if (settled) return;
    settled = true;
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    console.error(`[boot-guard] New version exited (code ${code}) before confirming it came up cleanly.`);
    rollback(marker);
    process.exit(1);
  });
}

main();
