import { fetchJson } from "../fetch-json";
import { createSupabaseBrowserClient } from "../supabase";
import type { MarkPrintedResultItem, RefundRouteResultItem } from "./types";

/**
 * Thin, typed wrappers around the SECURITY DEFINER RPCs from
 * SUPABASE_SETUP.md §7.7. Each RPC re-checks the caller's role itself — the
 * role gating implied by which of these an admin page exposes a button for
 * is a UX nicety, not the actual security boundary.
 */

/**
 * Actually issues the gateway refund(s), not just a DB flag — one call for
 * both a single "Refund" click (jobIds.length === 1) and a bulk "Refund
 * selected" click. Goes through app/api/admin/refund (a plain route, not
 * an RPC) since it needs RAZORPAY_KEY_SECRET server-side, which must never
 * reach RLS-gated browser code — that route independently re-verifies
 * owner access itself. Returns one result per job (never throws for an
 * individual job's own failure) so the caller can show per-job success/
 * failure and let the owner retry only the ones that failed.
 */
export async function requestRefunds(jobIds: string[]): Promise<RefundRouteResultItem[]> {
  const { results } = await fetchJson<{ results: RefundRouteResultItem[] }>("/api/admin/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobIds }),
  });
  return results;
}

/**
 * The "Refuse refund — printed fine" corrective action (requirement: a
 * paid job that actually printed, but got marked print_failed anyway, can
 * be fixed without an owner having to touch the database directly). Goes
 * through app/api/admin/mark-printed, not a direct RPC call, so the SAME
 * recordCompletedPrint revenue bookkeeping the print agent's own success
 * path uses can run server-side too — see lib/mark-printed.ts.
 */
export async function markJobsPrintedNoRefundNeeded(jobIds: string[], reason: string): Promise<MarkPrintedResultItem[]> {
  const { results } = await fetchJson<{ results: MarkPrintedResultItem[] }>("/api/admin/mark-printed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobIds, reason }),
  });
  return results;
}

export async function forceReprintJob(jobId: string): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("force_reprint_job", { p_job_id: jobId });
  if (error) throw new Error(error.message);
}

/**
 * "Reprint pages" (owner-only) — distinct from forceReprintJob above,
 * which just resubmits a job's EXISTING stored file as-is. This creates a
 * NEW job containing only the requested pages, so it goes through
 * app/api/admin/reprint (a plain route, not an RPC): that route needs to
 * download the original PDF, extract the requested pages, and re-upload
 * the result, none of which belongs inside a Postgres function.
 */
export async function requestReprint(input: {
  originalJobId: string;
  selectedPages: number[];
  copies: number;
  forceCoverSheet: boolean;
}): Promise<{ jobId: string; ticketNumber: number }> {
  return fetchJson<{ jobId: string; ticketNumber: number }>("/api/admin/reprint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
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
  lowSupplyThresholdPercent?: number;
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
    p_low_supply_threshold_percent: input.lowSupplyThresholdPercent ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function updateKioskAlertSettings(kioskId: string, telegramChatId: string): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_kiosk_alert_settings", { p_kiosk_id: kioskId, p_telegram_chat_id: telegramChatId || null });
  if (error) throw new Error(error.message);
}

export async function sendTestAlert(kioskId: string): Promise<{ results: { channel: string; ok: boolean; error?: string }[] }> {
  return fetchJson("/api/admin/test-alert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kioskId }),
  });
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

/**
 * Records a new paper/toner baseline — "Set current paper level"/"Paper
 * refilled" both call this with kind "paper", "Set cartridge page
 * count"/"Toner replaced" both call it with kind "toner". The RPC itself
 * writes the refill_events row and its audit entry in one transaction; see
 * supabase/schema.sql §10d.
 */
export async function recordRefill(kioskId: string, kind: "paper" | "toner", quantity: number, note?: string): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("record_refill", { p_kiosk_id: kioskId, p_kind: kind, p_quantity: quantity, p_note: note ?? null });
  if (error) throw new Error(error.message);
}

export interface UpdateKioskSeparatorSettingsInput {
  kioskId: string;
  separatorMode: "auto" | "always" | "never";
  recentJobMinutes: number;
  laterHoldHours: number;
  largeJobPages: number;
}

export async function updateKioskSeparatorSettings(input: UpdateKioskSeparatorSettingsInput): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_kiosk_separator_settings", {
    p_kiosk_id: input.kioskId,
    p_separator_mode: input.separatorMode,
    p_recent_job_minutes: input.recentJobMinutes,
    p_later_hold_hours: input.laterHoldHours,
    p_large_job_pages: input.largeJobPages,
  });
  if (error) throw new Error(error.message);
}

export async function clearKioskTray(kioskId: string): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("clear_kiosk_tray", { p_kiosk_id: kioskId });
  if (error) throw new Error(error.message);
}
