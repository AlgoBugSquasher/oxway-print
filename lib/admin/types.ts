import type { JobStatus, PrintSettingsSnapshot } from "../store";

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
  /** ROADMAP.md §24/§25 — reserved, unused this build. Always null; see the column's own comment in supabase/schema.sql. */
  collected_at: string | null;
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
}

/** Row shape returned by pricing_config — owner-only table, no masking needed. */
export interface PricingConfigRow {
  id: string;
  price_bw: number;
  price_color: number;
  updated_at: string;
  updated_by: string | null;
}
