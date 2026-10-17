import { ALERT_REMINDER_HOURS } from "../config";
import { supabaseAdmin } from "../supabase-admin";
import { sendEmail } from "./email";
import { sendTelegram } from "./telegram";
import type { AlertChannelResult, AlertKind, AlertMessage } from "./types";

export type { AlertKind, AlertMessage } from "./types";

async function listOwnerStaffEmails(): Promise<string[]> {
  const { data, error } = await supabaseAdmin().auth.admin.listUsers();
  if (error) throw new Error(`Could not list owner/staff emails: ${error.message}`);
  return data.users
    .filter((user) => {
      const role = (user.app_metadata as { role?: string } | undefined)?.role;
      return role === "owner" || role === "staff";
    })
    .map((user) => user.email)
    .filter((email): email is string => Boolean(email));
}

async function getTelegramChatId(kioskId: string): Promise<string | null> {
  const { data } = await supabaseAdmin().from("kiosk_alert_settings").select("telegram_chat_id").eq("kiosk_id", kioskId).maybeSingle();
  return (data as { telegram_chat_id: string | null } | null)?.telegram_chat_id ?? null;
}

async function dispatch(kioskId: string, kind: AlertKind, message: AlertMessage): Promise<AlertChannelResult[]> {
  const [chatId, emails] = await Promise.all([getTelegramChatId(kioskId), listOwnerStaffEmails().catch(() => [])]);
  const results = await Promise.all([sendTelegram(chatId, message), sendEmail(emails, message)]);

  await supabaseAdmin().rpc("log_audit", {
    p_action: "alert_sent",
    p_kiosk_id: kioskId,
    p_target_type: "alert",
    p_target_id: kind,
    p_details: { kind, results },
  });

  return results;
}

/**
 * Dedupe/reminder/recovery state machine shared by every alert kind. One
 * active row per (kiosk_id, kind) — enforced by a unique partial index, see
 * supabase/migrations/2026-10-22_low_supply_alerts.sql — so a race between
 * the cron and the post-job check can insert at most one.
 */
export async function evaluateAlert(kioskId: string, kind: AlertKind, isProblem: boolean, message: AlertMessage): Promise<void> {
  const supabase = supabaseAdmin();
  const { data: active } = await supabase.from("alerts").select("*").eq("kiosk_id", kioskId).eq("kind", kind).eq("status", "active").maybeSingle();

  if (!isProblem) {
    if (active) await supabase.from("alerts").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", active.id);
    return;
  }

  if (!active) {
    const { error } = await supabase.from("alerts").insert({ kiosk_id: kioskId, kind }).select("id").single();
    if (error) {
      if (error.code !== "23505") console.error(`Could not create alert row for ${kioskId}/${kind}:`, error.message);
      return;
    }
    await dispatch(kioskId, kind, message);
    return;
  }

  const lastSentAt = new Date(active.last_reminded_at ?? active.created_at).getTime();
  const hoursSinceLastSend = (Date.now() - lastSentAt) / 3_600_000;
  if (hoursSinceLastSend >= ALERT_REMINDER_HOURS) {
    await supabase.from("alerts").update({ last_reminded_at: new Date().toISOString() }).eq("id", active.id);
    await dispatch(kioskId, kind, message);
  }
}

export async function sendTestAlert(kioskId: string): Promise<AlertChannelResult[]> {
  return dispatch(kioskId, "paper_low", {
    title: `OXWAY test alert — ${kioskId}`,
    body: "This is a test alert from the admin panel. No action needed.",
  });
}
