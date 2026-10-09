import { fetchJson } from "../fetch-json";
import { createSupabaseBrowserClient } from "../supabase";

/**
 * Thin, typed wrappers around the SECURITY DEFINER RPCs from
 * SUPABASE_SETUP.md §7.7. Each RPC re-checks the caller's role itself — the
 * role gating implied by which of these an admin page exposes a button for
 * is a UX nicety, not the actual security boundary.
 */

/**
 * ROADMAP.md #10 — actually issues the gateway refund, not just a DB flag.
 * Goes through app/api/admin/refund (a plain route, not an RPC) since it
 * needs RAZORPAY_KEY_SECRET server-side, which must never reach RLS-gated
 * browser code — that route independently re-verifies owner access itself.
 */
export async function markJobRefunded(jobId: string): Promise<void> {
  await fetchJson("/api/admin/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
}

export async function forceReprintJob(jobId: string): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("force_reprint_job", { p_job_id: jobId });
  if (error) throw new Error(error.message);
}

export async function cancelJob(jobId: string): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("cancel_job", { p_job_id: jobId });
  if (error) throw new Error(error.message);
}

export interface UpdateKioskCountersInput {
  kioskId: string;
  trayPages?: number;
  cartridgePages?: number;
  trayMaxPages?: number;
  cartridgeMaxPages?: number;
  allowColor?: boolean;
  allowBw?: boolean;
}

export async function updateKioskCounters(input: UpdateKioskCountersInput): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_kiosk_counters", {
    p_kiosk_id: input.kioskId,
    p_tray_pages: input.trayPages ?? null,
    p_cartridge_pages: input.cartridgePages ?? null,
    p_tray_max_pages: input.trayMaxPages ?? null,
    p_cartridge_max_pages: input.cartridgeMaxPages ?? null,
    p_allow_color: input.allowColor ?? null,
    p_allow_bw: input.allowBw ?? null,
  });
  if (error) throw new Error(error.message);
}

/**
 * Owner-only (it controls messaging spend, see the RPC's own role check in
 * supabase/schema.sql) — a separate RPC from updateKioskCounters above
 * rather than a third parameter on it, same split as update_pricing being
 * its own owner-only RPC.
 */
export async function updateKioskWhatsappAvailability(kioskId: string, allowWhatsapp: boolean): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_kiosk_whatsapp_availability", { p_kiosk_id: kioskId, p_allow_whatsapp: allowWhatsapp });
  if (error) throw new Error(error.message);
}

/**
 * Remote "Update kiosk" / "Restart agent" — inserts the kiosk_commands row
 * the print agent's own poll loop picks up (print-agent/kiosk-update.ts).
 * The RPC itself refuses a second command while one's already
 * pending/running for that kiosk; kiosk-card.tsx's disabled button state is
 * just the UX mirror of that same guard.
 */
export async function requestKioskCommand(kioskId: string, command: "update" | "restart"): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("request_kiosk_command", { p_kiosk_id: kioskId, p_command: command });
  if (error) throw new Error(error.message);
}

export async function updatePricing(priceBw: number, priceColor: number): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_pricing", { p_price_bw: priceBw, p_price_color: priceColor });
  if (error) throw new Error(error.message);
}
