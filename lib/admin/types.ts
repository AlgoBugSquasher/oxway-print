import type { FailureEvidence, JobStatus, PrintSettingsSnapshot } from "../store";

export type { FailureEvidence };

export type AdminRole = "owner" | "staff" | "none";

/**
 * Row shape returned by print_jobs_admin_view — mirrors the view's own
 * column names (snake_case, same as the underlying table) rather than
 * introducing a separate camelCase mapper, since this view only ever feeds
 * the admin panel. `totalPrice` is `null` for staff — the database does the
 * masking (see SUPABASE_SETUP.md §7.4), not this type or any UI check.
 */
export interface AdminJobRow {
  id: string;
  status: JobStatus;
  file_name: string;
  selected_pages: number[];
  settings: PrintSettingsSnapshot;
  total_price: number | null;
  phone_number: string;
  notify_opt_in: boolean;
  notified_at: string | null;
  include_banner_page: boolean;
  provider: "cashfree" | "razorpay";
  provider_order_id: string;
  pdf_storage_path: string;
  kiosk_id: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  cups_job_id: string | null;
  refunded_at: string | null;
  /** ROADMAP.md §21 — the customer's own pickup code, null until assignTicketNumber runs (always set in practice, since that happens at job creation). */
  ticket_number: number | null;
  ticket_date: string | null;
  collected_at: string | null;
  collected_via: "customer" | "staff" | null;
  pickup_mode: "here" | "later";
  force_cover_sheet: boolean;
  sheet_kind: "none" | "separator" | "cover" | null;
  /** 'staff' for a free print created via app/api/staff-print, 'reprint' for one created via app/api/admin/reprint; 'razorpay'/'cashfree' (mirroring `provider`) for everything else. Null for jobs created before this column existed. */
  payment_method: "razorpay" | "cashfree" | "staff" | "reprint" | null;
  /** Which owner/staff account created this job — only ever set for a staff print. Resolve to an email via /api/admin/staff-users (print_jobs_admin_view can't join auth.users directly). */
  created_by_user_id: string | null;
  /** True only for a staff print. */
  is_free: boolean | null;
  /** The price this job WOULD have cost a paying customer — set only for a staff print, computed server-side from the real pricing rules. */
  waived_amount: number | null;
  /**
   * Refund approval workflow — null for every job that never needed a
   * refund (still live, or a free staff print). Owner-masked (null for
   * staff), same convention total_price already uses — this is the real
   * server-side enforcement of "staff cannot see this," not just which
   * admin page links where.
   */
  refund_status: "pending" | "processing" | "refunded" | "failed" | "not_needed" | null;
  refund_requested_at: string | null;
  refunded_by: string | null;
  refund_provider_id: string | null;
  refund_error: string | null;
  /** Human-readable reason while status is 'print_blocked' (e.g. "media-empty"). Null otherwise. */
  blocked_reason: string | null;
  /** Set once, the instant a print-agent restart discovers CUPS has no memory of this job — see print-agent/index.ts's reconcileInFlightJobsOnBoot. Never cleared afterward. */
  interrupted_reason: string | null;
  interrupted_at: string | null;
  /** Set only on a job created by the "Reprint pages" admin feature — points back at the job it's reprinting pages from. The single source of truth for the REPRINT badge. */
  original_job_id: string | null;
  /** Written on the ORIGINAL job the moment a reprint is created from it — e.g. "Reprinted pages 2 to 4 on 17 Oct 2026, 10:42 am." */
  reprint_note: string | null;
  /** The CUPS/elapsed-time evidence finalizeFailure (print-agent/index.ts) saw at the moment it decided this job failed — raw material behind `error`'s own short message. Null for a job that's never failed, or failed before this column existed. */
  failure_evidence: FailureEvidence | null;
  /** Set once lib/store.ts's deleteJobPdfOnly removed the stored PDF for a print_failed job whose refund stayed unresolved past REFUND_PENDING_FILE_RETENTION_DAYS — null means the file (if any) is still there. "Reprint pages" can't work once this is set. */
  pdf_deleted_at: string | null;
}

/** One job's own outcome from a refund request (single or bulk) — see app/api/admin/refund/route.ts. */
export interface RefundRouteResultItem {
  jobId: string;
  ok: boolean;
  refundId?: string;
  /** Already a clear, specific, customer-safe message — ready to show directly. */
  error?: string;
}

/** One job's own outcome from a "mark printed, no refund needed" request (single or bulk) — see app/api/admin/mark-printed/route.ts. */
export interface MarkPrintedResultItem {
  jobId: string;
  ok: boolean;
  /** Already a clear, specific message — ready to show directly. */
  error?: string;
}

/** Row shape returned by kiosk_status_admin_view. `total_revenue` is `null` for staff. */
export interface AdminKioskRow {
  id: string;
  tray_pages: number;
  cartridge_pages: number;
  tray_max_pages: number;
  cartridge_max_pages: number;
  total_revenue: number | null;
  total_lifetime_prints: number;
  updated_at: string;
  allow_color: boolean;
  allow_bw: boolean;
  /** Written by the print agent on every boot — null until it's booted at least once since this column was added. */
  agent_commit: string | null;
  agent_updated_at: string | null;
  /** Owner-only admin toggle — whether the WhatsApp opt-in is even offered at this kiosk. Defaults false. */
  allow_whatsapp: boolean;
  /** Running totals for free staff/owner prints (ROADMAP-style staff-print feature) — incremented at print completion, same timing as total_revenue. Not masked for staff the way total_revenue is. */
  free_print_count: number;
  free_print_pages: number;
  free_print_waived_amount: number;
  /** Written only by the print agent itself the instant it detects a recoverable printer problem — null means not currently blocked, the normal state. */
  print_blocked_reason: string | null;
  print_blocked_at: string | null;
  separator_mode: "auto" | "always" | "never";
  recent_job_minutes: number;
  later_hold_hours: number;
  large_job_pages: number;
  tray_cleared_at: string | null;
  low_supply_threshold_percent: number;
}

export type AlertKind = "paper_low" | "toner_low" | "kiosk_offline";

export interface AlertRow {
  id: string;
  kiosk_id: string;
  kind: AlertKind;
  status: "active" | "resolved";
  created_at: string;
  last_reminded_at: string | null;
  resolved_at: string | null;
}

export interface KioskAlertSettingsRow {
  kiosk_id: string;
  telegram_chat_id: string | null;
}

export type AdminKioskCommandName = "update" | "restart";
export type AdminKioskCommandStatus = "pending" | "running" | "done" | "failed";

/** Row shape returned by kiosk_commands_admin_view — one remote "Update kiosk"/"Restart agent" request. */
export interface AdminKioskCommandRow {
  id: string;
  kiosk_id: string;
  command: AdminKioskCommandName;
  status: AdminKioskCommandStatus;
  requested_by: string | null;
  requested_at: string;
  finished_at: string | null;
  result: string | null;
}

/** Row shape returned by pricing_config — owner-only table, no masking needed. */
export interface PricingConfigRow {
  id: string;
  price_bw: number;
  price_color: number;
  updated_at: string;
  updated_by: string | null;
}

export type OverviewPeriod = "today" | "week" | "month" | "year";

/**
 * One row from get_kiosk_period_breakdown — one bucket (hour/day/month,
 * depending on the period) of totals. Money fields are `null` for staff,
 * same masking convention as AdminKioskRow.total_revenue.
 */
export interface PeriodBreakdownRow {
  bucket_start: string;
  revenue: number | null;
  refund_amount: number | null;
  refund_count: number | null;
  pages_printed: number;
  prints_completed: number;
  free_print_count: number;
  free_print_pages: number;
  free_print_waived_amount: number | null;
  reprint_count: number;
  reprint_pages: number;
  separators_printed: number;
  covers_printed: number;
}

/** Row shape returned by get_pending_refund_summary — a single totals row, not bucketed by period (a pending refund is reported until resolved, regardless of when the original job happened). Both fields `null` for staff. */
export interface PendingRefundSummary {
  pending_refund_amount: number | null;
  pending_refund_count: number | null;
}

/** Row shape returned by get_kiosk_hourly_pattern — one of 24 dense-filled hours (Asia/Kolkata), for the Statistics section's "peak hours" chart. */
export interface HourlyPatternRow {
  hour_of_day: number;
  job_count: number;
  pages_printed: number;
}

/** Row shape returned by get_kiosk_weekday_pattern — one of 7 dense-filled weekdays (0 = Sunday, matching JS Date.getDay()), for "busiest day of the week." */
export interface WeekdayPatternRow {
  day_of_week: number;
  job_count: number;
  pages_printed: number;
}

/** Row shape returned by get_kiosk_daily_pattern — one dense-filled row per calendar day (Asia/Kolkata) in the period, for "best and quietest days." */
export interface DailyPatternRow {
  day: string;
  job_count: number;
  pages_printed: number;
}

/** Row shape returned by get_kiosk_sales_summary — a single totals row for the period. avg_order_value is `null` for staff; every other field is a count or rate, visible to staff same as pages_printed elsewhere. */
export interface SalesSummaryRow {
  color_jobs: number;
  bw_jobs: number;
  avg_pages_per_job: number;
  avg_order_value: number | null;
  failed_jobs: number;
  failure_rate: number;
  refunded_jobs: number;
  refund_rate: number;
}

/** Row shape returned by get_kiosk_supply_status — raw inputs only; lib/admin/supply-estimate.ts turns these into a remaining/percent/status a card can render. */
export interface SupplyStatusRow {
  cartridge_max_pages: number;
  has_paper_baseline: boolean;
  paper_quantity: number | null;
  paper_consumed_since: number | null;
  paper_refilled_at: string | null;
  paper_refilled_by: string | null;
  has_toner_baseline: boolean;
  toner_starting_pages: number | null;
  toner_consumed_since: number | null;
  toner_refilled_at: string | null;
  toner_refilled_by: string | null;
}

/** Row shape of refill_events — one "Paper refilled"/"Toner replaced" history entry. */
export interface RefillEventRow {
  id: string;
  kiosk_id: string;
  kind: "paper" | "toner";
  quantity: number;
  at: string;
  by_user_id: string | null;
  note: string | null;
}

/** Row shape of audit_log — owner-only (RLS), see supabase/schema.sql §11. `details` is deliberately untyped jsonb — each action's own shape is interpreted by lib/admin/audit-descriptions.ts, never assumed here. */
export interface AuditLogRow {
  id: number;
  at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  kiosk_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
}
