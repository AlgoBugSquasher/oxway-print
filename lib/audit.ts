import { supabaseAdmin } from "./supabase-admin";

/**
 * THE one way server-side Node code writes an audit entry — wraps the
 * log_audit() RPC (service_role only, see supabase/schema.sql §11). Every
 * other write RPC (update_pricing, cancel_job, request_kiosk_command,
 * update_kiosk_counters, update_kiosk_whatsapp_availability,
 * create_staff_print_job, record_refund) calls the SAME log_audit()
 * function directly from its own SQL body instead — both paths land in the
 * same table through the same one function, this is just the Node-side
 * entry point for code that isn't already inside one of those RPCs
 * (the login/sign-out routes, and the print agent's kiosk-command result).
 *
 * To add an audit entry for a brand-new feature later (refills, exports,
 * staff changes, ...): call `logAudit({ action: "my_new_action", ... })`
 * from wherever that feature's own server-side code already lives — a
 * Next.js route handler, or Node code on the print agent. No other wiring
 * needed. If the write instead naturally happens inside a new or existing
 * Postgres RPC, call `perform public.log_audit(...)` directly from that
 * RPC's own body instead (see supabase/schema.sql for the exact signature)
 * — that keeps the state change and its audit entry in the same
 * transaction, which Node-side logAudit() here can never guarantee.
 */
export interface AuditLogInput {
  action: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  kioskId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Never throws — a failed audit write must never crash the action it's
 * auditing (task requirement #4), but must still be loud server-side, so
 * a silently-broken audit trail doesn't go unnoticed. The RPC itself
 * (log_audit) ALSO swallows its own insert failure for SQL-side callers
 * mid-transaction; this is the equivalent backstop for this Node-side path.
 */
export async function logAudit(input: AuditLogInput): Promise<void> {
  try {
    const { error } = await supabaseAdmin().rpc("log_audit", {
      p_action: input.action,
      p_actor_user_id: input.actorUserId ?? null,
      p_actor_role: input.actorRole ?? null,
      p_kiosk_id: input.kioskId ?? null,
      p_target_type: input.targetType ?? null,
      p_target_id: input.targetId ?? null,
      p_details: input.details ?? null,
      p_ip: input.ip ?? null,
      p_user_agent: input.userAgent ?? null,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error(`[audit] Could not record "${input.action}":`, error, JSON.stringify(input));
  }
}

/** Last 4 digits only — never the full number. Returns "" unchanged (nothing to mask). */
export function maskPhone(phone: string): string {
  if (!phone) return phone;
  return `***${phone.slice(-4)}`;
}

/** The local part's first character plus its length, and the domain untouched — enough to recognize "was this the same account" in the audit trail without storing a reusable full email address for a failed/unknown login attempt. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}***(${local.length})${domain}`;
}
