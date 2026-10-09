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
  /** Null for a kiosk whose print agent has never sent a heartbeat since last_seen_at was added. */
  lastSeenAt: string | null;
}

/** Used by app/api/cron/check-kiosk-heartbeats to find silent kiosks (ROADMAP.md #8). */
export async function listKioskHeartbeats(): Promise<KioskHeartbeatRow[]> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("id, last_seen_at");
  if (error) throw new Error(`Could not list kiosk heartbeats: ${error.message}`);
  return (data as { id: string; last_seen_at: string | null }[]).map((row) => ({ id: row.id, lastSeenAt: row.last_seen_at }));
}

/**
 * Used by the website's kiosk-status API route (app/api/kiosk-status) to
 * drive the "kiosk isn't reachable" banner on the upload/configure and
 * post-payment pages. Server-side only (service-role client) — kiosk_status
 * also carries revenue/counter columns that must never reach the browser
 * directly, so this returns just the one field that route needs.
 */
export async function getKioskLastSeenAt(kioskId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("last_seen_at").eq("id", kioskId).maybeSingle();
  if (error) throw new Error(`Could not read kiosk last_seen_at: ${error.message}`);
  return (data as { last_seen_at: string | null } | null)?.last_seen_at ?? null;
}

export interface KioskColorModes {
  allowColor: boolean;
  allowBw: boolean;
}

/**
 * Used by both the customer-facing /api/kiosk-status (to grey out a
 * disabled mode) and /api/create-order (to actually reject one server-side
 * — the UI check alone isn't trustworthy). Defaults both to true (fail
 * open) if the kiosk_status row can't be found at all, consistent with
 * this file's other best-effort reads — a missing/misconfigured row should
 * never itself be the reason printing becomes unavailable.
 */
export async function getKioskColorModes(kioskId: string): Promise<KioskColorModes> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("allow_color, allow_bw").eq("id", kioskId).maybeSingle();
  if (error) throw new Error(`Could not read kiosk color modes: ${error.message}`);
  const row = data as { allow_color: boolean; allow_bw: boolean } | null;
  return { allowColor: row?.allow_color ?? true, allowBw: row?.allow_bw ?? true };
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

export interface KioskWhatsappAvailability {
  allowWhatsapp: boolean;
}

/**
 * Owner-only admin control — whether the WhatsApp "print ready" opt-in is
 * even offered at this kiosk at all, independent of whether a real MSG91
 * provider is actually configured (NOTIFY_PROVIDER). Used by
 * /api/kiosk-status (hide the opt-in checkbox entirely) and
 * /api/create-order (refuse to honor a client-sent notifyOptIn/phone when
 * this is false). Fails CLOSED (false on a missing/misconfigured row) —
 * unlike getKioskColorModes' fail-open default just below, offering an
 * opt-in nobody explicitly turned on is the wrong default here, not the
 * safe one (see allow_whatsapp's own default in supabase/schema.sql).
 */
export async function getKioskWhatsappAvailability(kioskId: string): Promise<KioskWhatsappAvailability> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("allow_whatsapp").eq("id", kioskId).maybeSingle();
  if (error) throw new Error(`Could not read kiosk WhatsApp availability: ${error.message}`);
  const row = data as { allow_whatsapp: boolean } | null;
  return { allowWhatsapp: row?.allow_whatsapp ?? false };
}

export interface KioskUpdateState {
  isUpdating: boolean;
}

/**
 * Used by /api/kiosk-status (customer page order-blocking) and the kiosk
 * display's connectivity hook (maintenance screen) — true while this
 * kiosk has a remote command still pending or running. `pending` counts as
 * updating too, not just `running`: a customer shouldn't be able to pay in
 * the few seconds between staff clicking "Update kiosk" and the agent's
 * own poll loop actually claiming the row (print-agent/kiosk-update.ts).
 */
export async function getKioskUpdateState(kioskId: string): Promise<KioskUpdateState> {
  const { data, error } = await supabaseAdmin()
    .from("kiosk_commands")
    .select("id")
    .eq("kiosk_id", kioskId)
    .in("status", ["pending", "running"])
    .limit(1);
  if (error) throw new Error(`Could not read kiosk update state: ${error.message}`);
  return { isUpdating: (data?.length ?? 0) > 0 };
}

/**
 * Written by the print agent on every boot (not just after an update) — see
 * print-agent/index.ts. Lets the admin panel's kiosk card confirm which
 * commit a kiosk is actually running and when it last restarted, independent
 * of whether a kiosk_commands row even exists yet (e.g. the very first boot
 * ever, before any remote command has been sent).
 */
export async function recordAgentBoot(kioskId: string, commitHash: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("kiosk_status")
      .update({ agent_commit: commitHash, agent_updated_at: new Date().toISOString() })
      .eq("id", kioskId);
    if (error) console.error("Failed to record agent boot commit:", error.message);
  } catch (error) {
    console.error("Failed to record agent boot commit:", error);
  }
}

/**
 * Heartbeat (ROADMAP.md #8) — writes kiosk_status.last_seen_at. Called on its
 * own timer from print-agent/index.ts, independent of the job-polling loop,
 * so a kiosk with no jobs for hours still reads as alive. Deliberately does
 * NOT touch updated_at — that column also moves on every print-counter
 * update (recordCompletedPrint above), so conflating the two would make
 * "last printed" and "last alive" indistinguishable.
 *
 * Best-effort like recordCompletedPrint — a failed heartbeat write shouldn't
 * crash the agent, it just means this beat is missed and the next one
 * (20s later) catches up.
 */
export async function touchKioskHeartbeat(kioskId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("kiosk_status")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", kioskId);
    if (error) console.error("Failed to update kiosk heartbeat:", error.message);
  } catch (error) {
    console.error("Failed to update kiosk heartbeat:", error);
  }
}
