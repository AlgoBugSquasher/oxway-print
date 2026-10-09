// Remote "Update kiosk" / "Restart agent" command data access — used only by
// print-agent/kiosk-update.ts (the admin panel writes commands through the
// role-gated request_kiosk_command() RPC instead, see lib/admin/actions.ts;
// this file's service-role functions are the Pi-side half of that pipe,
// same split as lib/store.ts's claim functions vs. the admin RPCs).
import { supabaseAdmin } from "./supabase-admin";

export type KioskCommandName = "update" | "restart";
export type KioskCommandStatus = "pending" | "running" | "done" | "failed";

export interface KioskCommandRecord {
  id: string;
  kioskId: string;
  command: KioskCommandName;
}

/**
 * Atomically claims the oldest still-pending command for a kiosk (pending ->
 * running) — the same UPDATE ... WHERE status = '<expected>' claim pattern
 * as lib/store.ts's claimJobForPrinting, so a retried poll tick can never
 * claim (and therefore run) the same command twice.
 */
export async function claimPendingKioskCommand(kioskId: string): Promise<KioskCommandRecord | null> {
  const { data: pendingRows, error: selectError } = await supabaseAdmin()
    .from("kiosk_commands")
    .select("id")
    .eq("kiosk_id", kioskId)
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .limit(1);
  if (selectError) throw new Error(`Could not list pending kiosk commands: ${selectError.message}`);

  const pending = (pendingRows as { id: string }[])[0];
  if (!pending) return null;

  const { data, error } = await supabaseAdmin()
    .from("kiosk_commands")
    .update({ status: "running" })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id, kiosk_id, command")
    .maybeSingle();
  if (error) throw new Error(`Could not claim kiosk command: ${error.message}`);
  if (!data) return null; // Lost the claim race — shouldn't happen with one agent per kiosk, but the guard is free.

  const row = data as { id: string; kiosk_id: string; command: KioskCommandName };
  return { id: row.id, kioskId: row.kiosk_id, command: row.command };
}

export async function finishKioskCommand(commandId: string, status: "done" | "failed", result: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("kiosk_commands")
    .update({ status, result, finished_at: new Date().toISOString() })
    .eq("id", commandId);
  if (error) throw new Error(`Could not finish kiosk command ${commandId}: ${error.message}`);
}

/**
 * Called once at agent startup, before polling for anything new. Covers the
 * case where the agent process died (power loss, manual kill, an unrelated
 * crash) while a command was still `running` with no update-marker to
 * reconcile it (see print-agent/update-marker.ts for the marker-driven
 * done/failed path an `update` command normally takes) — without this, that
 * row would show "running" in the admin panel forever. `exceptCommandId` lets
 * the caller exclude a command it's about to resolve itself via the marker
 * instead, so the two cleanup paths never race to finish the same row.
 */
export async function failDanglingRunningCommand(kioskId: string, exceptCommandId: string | null): Promise<void> {
  let query = supabaseAdmin()
    .from("kiosk_commands")
    .update({ status: "failed", result: "Interrupted — the agent restarted unexpectedly.", finished_at: new Date().toISOString() })
    .eq("kiosk_id", kioskId)
    .eq("status", "running");
  if (exceptCommandId) query = query.neq("id", exceptCommandId);
  const { error } = await query;
  if (error) console.error(`Could not clean up a dangling kiosk command for ${kioskId}:`, error.message);
}
