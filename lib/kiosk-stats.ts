// ROADMAP.md §2 (notifications) is disabled for v2.5 — see the two call
// sites below. Staff instead sees low-supply state directly via the badges
// already rendered in app/admin/(dashboard)/kiosk-card.tsx, which read
// tray_pages/cartridge_pages independently of this notify pipe.
// import { notifyLowSupply } from "./notify";
import { supabaseAdmin } from "./supabase-admin";

export interface CompletedPrintStats {
  pagesPrinted: number;
  amount: number;
  colorMode: boolean;
}

export interface KioskCounters {
  trayPages: number;
  cartridgePages: number;
}

export interface KioskHeartbeatRow {
  id: string;
  updatedAt: string;
}

/** Used by app/api/cron/check-kiosk-heartbeats to find silent kiosks (ROADMAP.md #8). */
export async function listKioskHeartbeats(): Promise<KioskHeartbeatRow[]> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("id, updated_at");
  if (error) throw new Error(`Could not list kiosk heartbeats: ${error.message}`);
  return (data as { id: string; updated_at: string }[]).map((row) => ({ id: row.id, updatedAt: row.updated_at }));
}

// Proactive threshold for both tray and cartridge — ROADMAP.md #8 previously
// had cartridge only warn at 100% (too late to act) while tray warned at
// 90%; both now use the same proactive 90% threshold.
const LOW_SUPPLY_THRESHOLD = 0.9;

/**
 * Logs a finished kiosk print job to Supabase and bumps the paper-tray /
 * cartridge / revenue counters the admin dashboard reads.
 *
 * Best-effort: Supabase syncing is a secondary concern to actually getting
 * the document printed, so failures here are logged and swallowed rather
 * than thrown. If Supabase isn't configured yet, this just no-ops.
 *
 * The low-supply check is computed against each kiosk's own editable
 * tray_max_pages / cartridge_max_pages (ROADMAP.md #6) rather than a
 * hardcoded page count, now that those columns actually exist and mean
 * something. STILL PARTIAL (#8 not fully done, and lower priority for this
 * build per ROADMAP.md's build order): the alert below is only a
 * console.warn plus the admin dashboard's own badges — actually reaching
 * the owner via SMS/WhatsApp needs §2 re-enabled first.
 *
 * Takes kioskId explicitly rather than assuming the single original kiosk —
 * v2 hardcoded "oxway_01" here despite kiosk_id being threaded through
 * every other table, so only one kiosk's counters ever updated correctly
 * regardless of how many kiosk_status rows existed. Fixed here since the
 * schema was already multi-kiosk-ready.
 */
export async function recordCompletedPrint(kioskId: string, stats: CompletedPrintStats): Promise<KioskCounters | null> {
  try {
    const supabase = supabaseAdmin();

    await supabase.from("print_orders").insert({
      pages_printed: stats.pagesPrinted,
      amount: stats.amount,
      color_mode: stats.colorMode,
      status: "completed",
    });

    const { data: kiosk, error } = await supabase
      .from("kiosk_status")
      .select("*")
      .eq("id", kioskId)
      .single();

    if (error || !kiosk) {
      console.warn(`kiosk_status record '${kioskId}' not found — skipping counter update.`);
      return null;
    }

    const trayPages = (kiosk.tray_pages || 0) + stats.pagesPrinted;
    const cartridgePages = (kiosk.cartridge_pages || 0) + stats.pagesPrinted;
    const totalRevenue = Number(kiosk.total_revenue || 0) + Number(stats.amount);
    const totalLifetimePrints = (kiosk.total_lifetime_prints || 0) + stats.pagesPrinted;
    const trayMaxPages = kiosk.tray_max_pages || 150;
    const cartridgeMaxPages = kiosk.cartridge_max_pages || 1500;

    await supabase
      .from("kiosk_status")
      .update({
        tray_pages: trayPages,
        cartridge_pages: cartridgePages,
        total_revenue: totalRevenue,
        total_lifetime_prints: totalLifetimePrints,
        updated_at: new Date().toISOString(),
      })
      .eq("id", kioskId);

    // Alert once on the print that *causes* the threshold to be crossed, not
    // on every subsequent job while still above it — otherwise a kiosk left
    // unrefilled for the next 50 jobs sends 50 texts instead of one.
    const wasTrayLow = (kiosk.tray_pages || 0) / trayMaxPages >= LOW_SUPPLY_THRESHOLD;
    const wasCartridgeLow = (kiosk.cartridge_pages || 0) / cartridgeMaxPages >= LOW_SUPPLY_THRESHOLD;
    if (!wasTrayLow && trayPages / trayMaxPages >= LOW_SUPPLY_THRESHOLD) {
      console.warn(`[ALERT] Kiosk "${kioskId}" — refill paper tray! Current count: ${trayPages}/${trayMaxPages}`);
      // await notifyLowSupply(kioskId, "tray", trayPages, trayMaxPages).catch((err) => console.error("notifyLowSupply failed:", err));
    }
    if (!wasCartridgeLow && cartridgePages / cartridgeMaxPages >= LOW_SUPPLY_THRESHOLD) {
      console.warn(`[ALERT] Kiosk "${kioskId}" — refill cartridge! Current count: ${cartridgePages}/${cartridgeMaxPages}`);
      // await notifyLowSupply(kioskId, "cartridge", cartridgePages, cartridgeMaxPages).catch((err) => console.error("notifyLowSupply failed:", err));
    }

    return { trayPages, cartridgePages };
  } catch (error) {
    console.error("Failed to record completed print in Supabase:", error);
    return null;
  }
}

/**
 * Heartbeat (ROADMAP.md #8) — reuses kiosk_status.updated_at rather than a
 * dedicated column. Called on its own timer from print-agent/index.ts,
 * independent of the job-polling loop, so a kiosk with no jobs for hours
 * still reads as alive. Best-effort like recordCompletedPrint — a failed
 * heartbeat write shouldn't crash the agent, it just means this beat is
 * missed and the next one (a minute later) catches up.
 */
export async function touchKioskHeartbeat(kioskId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("kiosk_status")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", kioskId);
    if (error) console.error("Failed to update kiosk heartbeat:", error.message);
  } catch (error) {
    console.error("Failed to update kiosk heartbeat:", error);
  }
}
