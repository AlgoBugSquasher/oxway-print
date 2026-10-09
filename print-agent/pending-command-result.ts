// Same dependency-free fs pattern as update-marker.ts, for a narrower
// problem: kiosk-update.ts decides a command's outcome (failed, from a git
// pull or npm install failure) and tries to report it to Supabase inline,
// in the same tick — but if the Pi's own network drops at exactly that
// moment, that report write can fail too. Without this, the kiosk_commands
// row would be stuck at "running" forever (claimPendingKioskCommand only
// ever looks at "pending" rows, so nothing would retry finishing it), with
// no way back short of restarting the agent. This persists the decided
// outcome locally so the next poll tick retries the write instead of
// losing it — self-healing the moment connectivity returns, no restart
// needed.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const PENDING_RESULT_PATH = path.join(process.cwd(), ".kiosk-command-result.json");

export interface PendingCommandResult {
  commandId: string;
  status: "done" | "failed";
  result: string;
}

export function readPendingCommandResult(): PendingCommandResult | null {
  if (!existsSync(PENDING_RESULT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PENDING_RESULT_PATH, "utf8")) as PendingCommandResult;
  } catch {
    return null;
  }
}

export function writePendingCommandResult(result: PendingCommandResult): void {
  writeFileSync(PENDING_RESULT_PATH, JSON.stringify(result), "utf8");
}

export function clearPendingCommandResult(): void {
  if (existsSync(PENDING_RESULT_PATH)) unlinkSync(PENDING_RESULT_PATH);
}
