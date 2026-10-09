// Deliberately zero imports beyond Node's own `fs`/`path` — this file is
// shared by boot-guard.ts (which must stay parseable and runnable even when
// an `update` command just pulled genuinely broken application code, see
// that file's own docstring) and kiosk-update.ts. Anything pulled in from
// lib/ or an npm package here would defeat the whole point: boot-guard's
// crash/rollback detection has to work using nothing the broken update could
// plausibly have taken down with it.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Lives at the repo root, NOT inside a git-tracked path (see .gitignore) —
// `git reset --hard` only touches tracked files, so this marker survives
// the exact rollback operation it's coordinating.
const MARKER_PATH = path.join(process.cwd(), ".kiosk-update-state.json");

export type UpdateMarkerStatus = "verifying" | "rolled_back";

export interface UpdateMarker {
  /** The kiosk_commands row this boot sequence is ultimately reporting back to. */
  commandId: string;
  /** Recorded before the update ever touched anything — what to roll back to. */
  previousCommit: string;
  status: UpdateMarkerStatus;
}

export function readUpdateMarker(): UpdateMarker | null {
  if (!existsSync(MARKER_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MARKER_PATH, "utf8")) as UpdateMarker;
  } catch {
    // Corrupt/partially-written marker — treat as "nothing to reconcile"
    // rather than crashing boot-guard over a file it can just overwrite
    // the next time an update actually runs.
    return null;
  }
}

export function writeUpdateMarker(marker: UpdateMarker): void {
  writeFileSync(MARKER_PATH, JSON.stringify(marker), "utf8");
}

export function clearUpdateMarker(): void {
  if (existsSync(MARKER_PATH)) unlinkSync(MARKER_PATH);
}
