// ROADMAP.md §2 (notifications) is disabled for v2.5 — see the two call
// sites below. Staff instead sees low-supply state directly via the badges
// already rendered in app/admin/(dashboard)/kiosk-card.tsx, which read
// tray_pages/cartridge_pages independently of this notify pipe.
// import { notifyLowSupply } from "./notify";
import { supabaseAdmin } from "./supabase-admin";

export interface CompletedPrintStats {
  pagesPrinted: number;
  /** Real money actually collected for this job — 0 for a free staff/owner print or a reprint (see waivedAmount for what a free print would have cost). */
  amount: number;
  colorMode: boolean;
  /**
   * The price a free staff/owner print (job.isFree) WOULD have cost a
   * paying customer — what free_print_waived_amount and print_orders'
   * own waived_amount column accumulate, kept separate from `amount`
   * (always real revenue, always 0 for a free print) so the two concepts
   * can never be conflated. Unused unless isFree is true.
   */
  waivedAmount?: number;
  /**
   * True for a free staff/owner print (job.isFree) — when set, this
   * completed print bumps free_print_count/free_print_pages/
   * free_print_waived_amount instead of total_revenue. See the admin
   * dashboard's "Free staff prints" summary.
   */
  isFree?: boolean;
  /**
   * True for a "Reprint pages" job (job.originalJobId set) — physical
   * paper/toner consumption still counts (tray/cartridge/
   * total_lifetime_prints below), but NEITHER total_revenue NOR
   * free_print_* increment: this isn't new revenue, and it isn't a
   * discretionary staff favor either — it's compensating for the agent's
   * own earlier failure/interruption on the ORIGINAL job. Takes priority
   * over isFree if both were somehow set (they never are in practice — a
   * reprint job's own isFree is always false, see PrintJobRecord's
   * originalJobId comment).
   */
  isReprint?: boolean;
  /** Mirrors the job's own sheet_kind ('none'/'separator'/'cover') — kept on the durable print_orders ledger too since print_jobs rows get cleaned up after a few hours (see get_kiosk_period_breakdown's own comment in supabase/schema.sql). */
  sheetKind?: "none" | "separator" | "cover";
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

    // print_orders is the durable ledger get_kiosk_period_breakdown() reads
    // from (print_jobs rows this job itself lives in get cleaned up a few
    // hours after printing — see that function's own comment in
    // supabase/schema.sql) — every completed print is logged here,
    // including free/reprint ones, so the admin overview's period
    // breakdown can still show accurate free-print/reprint counts for a
    // period long after the underlying print_jobs row is gone. Revenue
    // itself stays correct because is_free/is_reprint are stored alongside
    // and excluded from the revenue sum in SQL, not by skipping the insert.
    await supabase.from("print_orders").insert({
      kiosk_id: kioskId,
      pages_printed: stats.pagesPrinted,
      amount: stats.amount,
      color_mode: stats.colorMode,
      status: "completed",
      is_free: stats.isFree ?? false,
      is_reprint: stats.isReprint ?? false,
      waived_amount: stats.isFree ? (stats.waivedAmount ?? 0) : null,
      sheet_kind: stats.sheetKind ?? "none",
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

    // Paper/toner consumption is physical and real regardless of who paid
    // for it, so tray/cartridge/total_lifetime_prints always increment —
    // only the MONEY side (total_revenue vs. free_print_* vs. nothing at
    // all) branches on isFree/isReprint below.
    const trayPages = (kiosk.tray_pages || 0) + stats.pagesPrinted;
    const cartridgePages = (kiosk.cartridge_pages || 0) + stats.pagesPrinted;
    const totalLifetimePrints = (kiosk.total_lifetime_prints || 0) + stats.pagesPrinted;
    const trayMaxPages = kiosk.tray_max_pages || 150;
    const cartridgeMaxPages = kiosk.cartridge_max_pages || 1500;

    const moneyColumns = stats.isReprint
      ? {}
      : stats.isFree
        ? {
            free_print_count: (kiosk.free_print_count || 0) + 1,
            free_print_pages: (kiosk.free_print_pages || 0) + stats.pagesPrinted,
            free_print_waived_amount: Number(kiosk.free_print_waived_amount || 0) + Number(stats.waivedAmount || 0),
          }
        : { total_revenue: Number(kiosk.total_revenue || 0) + Number(stats.amount) };

    await supabase
      .from("kiosk_status")
      .update({
        tray_pages: trayPages,
        cartridge_pages: cartridgePages,
        total_lifetime_prints: totalLifetimePrints,
        ...moneyColumns,
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

export interface KioskPrintBlockedState {
  printBlocked: boolean;
  printBlockedReason: string | null;
}

/**
 * Used by both the customer-facing /api/kiosk-status (to block starting a
 * new order and show the "temporarily unavailable" banner — requirement:
 * "Do not let new customers pay while the machine cannot print") and
 * /api/create-order (to actually reject one server-side — the UI check
 * alone isn't trustworthy, same reasoning getKioskColorModes/
 * getKioskUpdateState already establish for their own checks). Fails OPEN
 * (not blocked) on a missing/misconfigured row, same convention
 * getKioskColorModes uses — a row that can't be found should never itself
 * be the reason printing becomes unavailable.
 */
export async function getKioskPrintBlockedState(kioskId: string): Promise<KioskPrintBlockedState> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("print_blocked_reason").eq("id", kioskId).maybeSingle();
  if (error) throw new Error(`Could not read kiosk print-blocked state: ${error.message}`);
  const row = data as { print_blocked_reason: string | null } | null;
  const reason = row?.print_blocked_reason ?? null;
  return { printBlocked: reason !== null, printBlockedReason: reason };
}

/**
 * Written by the print agent itself (print-agent/index.ts) the instant it
 * detects a RECOVERABLE printer problem (out of paper, door open, low
 * toner, offline — see lib/print/cups.ts) — never by the website. Clears
 * on its own (clearKioskPrintBlocked below) the moment the printer's ready
 * again, with no admin action needed either way. Best-effort, same
 * reasoning every other write in this file uses: a failed write here just
 * means the website's own "temporarily unavailable" banner is a beat
 * behind reality, never a reason to crash the print agent's own loop over
 * something this secondary.
 */
export async function setKioskPrintBlocked(kioskId: string, reason: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("kiosk_status")
      .update({ print_blocked_reason: reason, print_blocked_at: new Date().toISOString() })
      .eq("id", kioskId);
    if (error) console.error("Failed to record kiosk print-blocked state:", error.message);
  } catch (error) {
    console.error("Failed to record kiosk print-blocked state:", error);
  }
}

/** Clears print_blocked_reason back to null — called the moment the SAME blocked job either resumes printing on its own or is finally given up on (both leave the kiosk itself no longer blocked; a NEW job starting fresh also clears this via the same pre-flight check). */
export async function clearKioskPrintBlocked(kioskId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("kiosk_status")
      .update({ print_blocked_reason: null, print_blocked_at: null })
      .eq("id", kioskId);
    if (error) console.error("Failed to clear kiosk print-blocked state:", error.message);
  } catch (error) {
    console.error("Failed to clear kiosk print-blocked state:", error);
  }
}

export interface KioskSeparatorSettings {
  separatorMode: "auto" | "always" | "never";
  recentJobMinutes: number;
  laterHoldHours: number;
  largeJobPages: number;
}

export async function getKioskSeparatorSettings(kioskId: string): Promise<KioskSeparatorSettings> {
  const { data, error } = await supabaseAdmin()
    .from("kiosk_status")
    .select("separator_mode, recent_job_minutes, later_hold_hours, large_job_pages")
    .eq("id", kioskId)
    .maybeSingle();
  if (error) throw new Error(`Could not read kiosk separator settings: ${error.message}`);
  const row = data as { separator_mode: "auto" | "always" | "never"; recent_job_minutes: number; later_hold_hours: number; large_job_pages: number } | null;
  return {
    separatorMode: row?.separator_mode ?? "auto",
    recentJobMinutes: row?.recent_job_minutes ?? 5,
    laterHoldHours: row?.later_hold_hours ?? 2,
    largeJobPages: row?.large_job_pages ?? 15,
  };
}

export async function getKioskTrayClearedAt(kioskId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().from("kiosk_status").select("tray_cleared_at").eq("id", kioskId).maybeSingle();
  if (error) throw new Error(`Could not read kiosk tray_cleared_at: ${error.message}`);
  return (data as { tray_cleared_at: string | null } | null)?.tray_cleared_at ?? null;
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
