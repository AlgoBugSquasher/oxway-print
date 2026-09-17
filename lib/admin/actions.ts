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
}

export async function updateKioskCounters(input: UpdateKioskCountersInput): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_kiosk_counters", {
    p_kiosk_id: input.kioskId,
    p_tray_pages: input.trayPages ?? null,
    p_cartridge_pages: input.cartridgePages ?? null,
    p_tray_max_pages: input.trayMaxPages ?? null,
    p_cartridge_max_pages: input.cartridgeMaxPages ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function updatePricing(priceBw: number, priceColor: number): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  const { error } = await supabase.rpc("update_pricing", { p_price_bw: priceBw, p_price_color: priceColor });
  if (error) throw new Error(error.message);
}
