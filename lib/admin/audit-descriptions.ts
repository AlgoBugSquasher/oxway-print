import type { AuditLogRow } from "./types";

/**
 * Every action name any part of this app ever writes to audit_log, mapped
 * to a short, human label — used for both the viewer's readable
 * descriptions and its action filter dropdown. Adding a new audited action
 * elsewhere (see lib/audit.ts's own "how to add one" comment) means adding
 * its label here too, or it falls back to the raw action string (still
 * functional, just less readable) — nothing else needs to change.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login_success: "Signed in",
  login_failed: "Sign-in failed",
  sign_out: "Signed out",
  pricing_updated: "Pricing changed",
  kiosk_settings_updated: "Kiosk settings changed",
  kiosk_whatsapp_updated: "WhatsApp availability changed",
  kiosk_separator_settings_updated: "Separator settings changed",
  tray_cleared: "Tray cleared",
  job_cancelled: "Job cancelled",
  job_refunded: "Job refunded",
  job_reprinted: "Pages reprinted",
  refund_failed: "Refund attempt failed",
  refund_bulk_requested: "Bulk refund requested",
  staff_print_created: "Free staff print created",
  kiosk_command_requested: "Kiosk command requested",
  kiosk_command_finished: "Kiosk command finished",
  alert_sent: "Alert sent",
  alert_settings_updated: "Alert settings changed",
  job_marked_printed_no_refund: "Refund refused — marked printed",
};

/** Every action name in display order, for the viewer's filter dropdown. */
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABELS);

export function describeAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * The one-line summary shown in the audit log's own list (not the
 * expanded before/after view, which the viewer page renders separately
 * straight from `entry.details`) — folds in the few details worth seeing
 * at a glance without opening the row, kept short on purpose.
 */
export function summarizeAuditEntry(entry: AuditLogRow): string {
  const label = describeAuditAction(entry.action);
  const details = entry.details ?? {};

  switch (entry.action) {
    case "login_failed": {
      const email = typeof details.emailAttempted === "string" ? details.emailAttempted : null;
      return email ? `${label} (${email})` : label;
    }
    case "pricing_updated": {
      const after = details.after as { price_bw?: number; price_color?: number } | undefined;
      return after ? `${label}: B&W ₹${after.price_bw}, Color ₹${after.price_color}` : label;
    }
    case "job_cancelled":
    case "job_refunded":
      return entry.target_id ? `${label} (job ${shortenId(entry.target_id)})` : label;
    case "job_reprinted": {
      const pages = Array.isArray(details.pages) ? details.pages.length : null;
      const copies = typeof details.copies === "number" ? details.copies : null;
      const job = entry.target_id ? ` (original job ${shortenId(entry.target_id)})` : "";
      return pages !== null
        ? `${label}: ${pages} page${pages === 1 ? "" : "s"}${copies !== null ? ` x${copies}` : ""}${job}`
        : `${label}${job}`;
    }
    case "refund_failed": {
      const error = typeof details.error === "string" ? details.error : null;
      const job = entry.target_id ? ` (job ${shortenId(entry.target_id)})` : "";
      return error ? `${label}${job}: ${error}` : `${label}${job}`;
    }
    case "refund_bulk_requested": {
      const count = typeof details.count === "number" ? details.count : null;
      const succeeded = typeof details.succeeded === "number" ? details.succeeded : null;
      const total = typeof details.total === "number" ? details.total : null;
      return count !== null
        ? `${label}: ${succeeded ?? "?"}/${count} succeeded${total !== null ? `, ₹${total.toFixed(2)}` : ""}`
        : label;
    }
    case "staff_print_created": {
      const pages = typeof details.pages === "number" ? details.pages : null;
      return pages !== null ? `${label}: ${pages} page${pages === 1 ? "" : "s"}` : label;
    }
    case "kiosk_command_requested":
    case "kiosk_command_finished": {
      const command = typeof details.command === "string" ? details.command : null;
      const status = typeof details.status === "string" ? ` — ${details.status}` : "";
      return command ? `${label}: ${command}${status}` : label;
    }
    case "alert_sent": {
      const kind = typeof details.kind === "string" ? details.kind : null;
      const results = Array.isArray(details.results) ? (details.results as { channel?: string; ok?: boolean }[]) : [];
      const channels = results.map((r) => `${r.channel}${r.ok ? "" : " (failed)"}`).join(", ");
      return kind ? `${label}: ${kind}${channels ? ` via ${channels}` : ""}` : label;
    }
    case "job_marked_printed_no_refund": {
      const reason = typeof details.reason === "string" ? details.reason : null;
      const job = entry.target_id ? ` (job ${shortenId(entry.target_id)})` : "";
      return reason ? `${label}${job}: ${reason}` : `${label}${job}`;
    }
    default:
      return label;
  }
}

/** The job's own uuid is too long to usefully scan in a list — the first 8 characters match lib/request-id.ts's own shortRequestId convention used everywhere else in the admin panel. */
function shortenId(id: string): string {
  return id.slice(0, 8);
}

/** True when `details` has the {before, after} shape every toggle/setting-change action writes — the viewer renders these two specially, side by side, instead of a flat key/value dump. */
export function hasBeforeAfter(details: Record<string, unknown> | null): details is { before: Record<string, unknown>; after: Record<string, unknown> } & Record<string, unknown> {
  return Boolean(details && typeof details.before === "object" && details.before !== null && typeof details.after === "object" && details.after !== null);
}
