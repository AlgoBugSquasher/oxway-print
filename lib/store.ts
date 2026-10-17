import { supabaseAdmin } from "./supabase-admin";
import { ABANDONED_JOB_RETENTION_HOURS, SUPABASE_PRINT_BUCKET, TERMINAL_JOB_RETENTION_HOURS } from "./config";

export type JobStatus =
  | "pending_payment"
  | "paid"
  | "printing"
  | "printed"
  | "print_failed"
  | "payment_failed"
  | "expired"
  | "cancelled"
  /**
   * A paid job that was being printed hit a RECOVERABLE printer problem
   * (out of paper, a door/cover open, low toner, offline) — see
   * print-agent/index.ts's print loop and lib/print/cups.ts's own
   * classification. Deliberately NOT print_failed: the job is still live,
   * still counted as "ahead in queue" for other customers' ETA, and will
   * resume automatically once the printer's ready again, up to
   * READY_TIMING_CONFIG.blockedRetryLimitSeconds before it's finally given
   * up on. blockedReason (below) holds the human-readable why.
   */
  | "print_blocked"
  /**
   * The print agent restarted while this job was still 'printing' or
   * 'print_blocked', and on reboot CUPS had no memory of it at all (not in
   * its active queue, not in its completed-job history) — see
   * print-agent/index.ts's reconcileInFlightJobsOnBoot and
   * lib/print/cups.ts's isCupsJobKnown for exactly how that's detected, and
   * that function's own reliability note for the one real limitation (a
   * job that actually finished successfully a LONG time before the agent
   * came back up can look identical to one CUPS genuinely lost, if its
   * completed-job history already rotated the entry out).
   *
   * Deliberately NOT print_failed: a restart is never, by itself, evidence
   * the print failed — it's evidence the agent can no longer VOUCH for
   * what happened. So this never triggers a refund (set_print_job_refund_pending
   * only ever fires on a transition into 'print_failed', never this) and is
   * never auto-reprinted — an owner decides from the admin Jobs list
   * whether to use the "Reprint pages" feature (original_job_id below) once
   * they've actually checked whether it printed.
   */
  | "interrupted";

export interface PrintSettingsSnapshot {
  copies: number;
  layout: "portrait" | "landscape";
  isColor: boolean;
  paperSize: "A4" | "Letter" | "Legal";
  pagesPerSheet: 1 | 2 | 4;
}

export interface PrintJobRecord {
  id: string;
  status: JobStatus;
  fileName: string;
  selectedPages: number[];
  settings: PrintSettingsSnapshot;
  totalPrice: number;
  /** Customer's phone number — only ever populated when notifyOptIn is true. */
  phoneNumber: string;
  /** WhatsApp "print ready" opt-in, checked at checkout. Gates both phoneNumber collection and whether lib/notify/'s provider ever sends anything for this job. */
  notifyOptIn: boolean;
  /** Set once a terminal-state WhatsApp notification is actually sent — the atomic claim guard in claimJobForNotification below relies on this being null beforehand. */
  notifiedAt?: string;
  provider: "cashfree" | "razorpay";
  /** Gateway's own order id, used to look the job up from webhooks and polling. */
  providerOrderId: string;
  providerMeta?: Record<string, string>;
  /** Path inside SUPABASE_PRINT_BUCKET where the final, print-ready PDF lives. */
  pdfStoragePath: string;
  /**
   * Customer opt-in for a pickup-ID cover page — see ROADMAP.md #5. A
   * top-level column, not folded into `settings`, since it's a print-agent
   * composition decision (whether to prepend a banner page), not a CUPS
   * printer option.
   */
  includeBannerPage: boolean;
  /**
   * SHA-256 of the uploaded file's bytes, used only for the duplicate-order
   * check in findRecentDuplicateJob — see ROADMAP.md #13.
   */
  contentHash: string;
  /**
   * Which physical kiosk this job should print at. Defaults to "oxway_01"
   * (today's single kiosk) so nothing changes until a second kiosk exists.
   */
  kioskId: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  cupsJobId?: string;
  /** Set once a refund genuinely completes at the payment gateway — see refundStatus below for the fuller lifecycle this is now one part of. Independent of `status` — a job's payment/print outcome and its refund state are two separate facts. */
  refundedAt?: string;
  /**
   * Refund approval workflow — undefined/null means "never needed a
   * refund" (still live, or a free staff print, which never had money move
   * in the first place). Set to 'pending' automatically (by a database
   * trigger — see supabase/schema.sql's set_print_job_refund_pending) the
   * instant a paid job first becomes print_failed; an owner then reviews
   * it from the admin Refunds page (lib/refund.ts's attemptRefund), which
   * atomically claims it to 'processing' before ever calling the payment
   * gateway, then resolves it to 'refunded' or 'failed'.
   */
  /**
   * 'not_needed' means a job's refund was pending when, instead, an owner
   * used the "Reprint pages" feature on it and that reprint went on to
   * print successfully (see the set_original_job_refund_not_needed
   * trigger) — the customer got their document after all, so the refund
   * that was about to happen is no longer warranted. Distinct from
   * undefined/null ("this job never needed a refund in the first place")
   * even though both ultimately mean "nothing to pay out" — 'not_needed'
   * specifically records that a refund WAS pending and was resolved by a
   * reprint instead, for an owner reviewing the history later.
   */
  refundStatus?: "pending" | "processing" | "refunded" | "failed" | "not_needed";
  /** Stamped once, the instant refundStatus first becomes 'pending' — never touched again by a later retry. */
  refundRequestedAt?: string;
  /** Which signed-in owner approved the refund that actually succeeded — only ever set once refundStatus reaches 'refunded'. */
  refundedBy?: string;
  /** The gateway's own refund id — only ever set once refundStatus reaches 'refunded'. */
  refundProviderId?: string;
  /** The most recent refund attempt's own failure message — only meaningful while refundStatus is 'failed'. */
  refundError?: string;
  /** Human-readable reason this job is currently 'print_blocked' (e.g. "media-empty") — see lib/print/cups.ts's classification. Only meaningful while status is 'print_blocked'; cleared (set back to undefined) the moment it resumes or is finally failed. */
  blockedReason?: string;
  /** Why this job is 'interrupted' (e.g. "Print agent restarted; CUPS had no record of this job.") — see print-agent/index.ts's boot reconciliation. Only meaningful while status is 'interrupted'; never cleared afterward (it's a historical fact about what happened, not a live condition). */
  interruptedReason?: string;
  /** When this job was marked 'interrupted' — stamped once, at that same moment. */
  interruptedAt?: string;
  /**
   * Set only on a job CREATED by the "Reprint pages" admin feature —
   * points back at the job it's reprinting pages from. This, not a
   * separate boolean, is the single source of truth for "is this job a
   * reprint" (drives the REPRINT badge in the admin Jobs list, the
   * Razorpay-enrichment skip in print-agent/index.ts, the refund-pending
   * trigger's exclusion, and recordCompletedPrint's isReprint flag).
   */
  originalJobId?: string;
  /**
   * Written on the ORIGINAL job the moment someone reprints pages from it
   * (requirement: "Add a note on the original job") — e.g. "Reprinted
   * pages 2-4 on 17 Oct 2026, 10:42 am." Purely informational; never read
   * by any code, only displayed.
   */
  reprintNote?: string;
  pickupMode?: "here" | "later";
  forceCoverSheet?: boolean;
  sheetKind?: "none" | "separator" | "cover";
  collectedAt?: string;
  collectedVia?: "customer" | "staff";
  /**
   * Short per-kiosk, per-day pickup code (e.g. 42, shown to the customer as
   * "#042") — see ROADMAP.md §21. Assigned exactly once, atomically, at job
   * creation via `assignTicketNumber` below; never reassigned afterward.
   */
  ticketNumber?: number;
  /**
   * The calendar date `next_ticket_number()` actually used when assigning
   * ticketNumber — read back from the database rather than computed by the
   * app server, so it's always consistent with which `kiosk_ticket_counters`
   * row was incremented (see that function's own comment in schema.sql).
   */
  ticketDate?: string;
  /**
   * Razorpay payment id (pay_XXXX), the UPI transaction id (RRN/UTR, from
   * acquirer_data.upi_transaction_id) and the gateway-confirmed paid amount
   * — populated best-effort when a Razorpay payment is reconciled (see
   * lib/payment-reconciliation.ts) and printed on the banner (see
   * lib/print/banner.ts). Always null for Cashfree jobs and for jobs paid
   * before this existed. Deliberately NOT exposed to the anon role, the
   * customer-facing job endpoint, Realtime, or the admin view — see the
   * migration that added these columns.
   */
  paymentId?: string;
  upiTxnId?: string;
  paidAmount?: number;
  /**
   * How this job actually got paid — 'staff' for a free print created by
   * createStaffPrintJob below, 'reprint' for one created by
   * createReprintJob (also free, but distinct — see originalJobId's own
   * comment for why this isn't folded into 'staff'), 'razorpay'/'cashfree'
   * mirroring `provider` for everything else. Undefined for jobs created
   * before this column existed. This, not `provider`, is the real source
   * of truth for "is this a staff/reprint job" — every refund/banner/
   * Razorpay-enrichment call site checks it FIRST, since `provider` is
   * still set to a real (but meaningless) value on one of these too (see
   * the migration's own comment on why).
   */
  paymentMethod?: "razorpay" | "cashfree" | "staff" | "reprint";
  /** Which signed-in owner/staff user created this job — only ever set for a staff print (createStaffPrintJob). */
  createdByUserId?: string;
  /** True only for a staff print — total_price is 0 and waivedAmount below holds what it would have cost. */
  isFree?: boolean;
  /** The price this job WOULD have cost a paying customer, computed server-side from the real pricing rules (see app/api/staff-print/route.ts) — never from anything the client claims. Undefined for every non-staff job. */
  waivedAmount?: number;
  /** Client-supplied idempotency key for a staff-print submission — makes a double-click/retry resolve to the same job instead of creating a duplicate (enforced by a partial unique index, not just this app-level field). Undefined for non-staff jobs. */
  idempotencyKey?: string;
  /**
   * Stamped automatically by a database trigger the instant this job's
   * status first becomes 'paid' — what the print agent's queue is actually
   * ordered by (see claimNextPaidJob below), not createdAt, so neither a
   * customer job nor a staff job ever gets priority over the other. Not
   * something application code ever sets directly.
   */
  queueTime?: string;
  /**
   * Per-job print-stage timestamps (see lib/print/ready-timing.ts), stamped
   * as the job moves through the print agent — claimedAt by
   * claim_next_paid_job() itself, the rest by the agent as it progresses.
   * Diagnostic only: never exposed to the anon role, Realtime, or either
   * customer-facing "is it ready" surface, which still only ever reads
   * `status` (see that migration's own comment for why).
   */
  claimedAt?: string;
  spooledAt?: string;
  printerIdleAt?: string;
  readyAt?: string;
}

// 'interrupted' included — it's never going to resolve on its own (no
// watcher is tracking it; see JobStatus's own comment), so it's eligible
// for cleanup after TERMINAL_JOB_RETENTION_HOURS exactly like any other
// resolved job, UNLESS an owner reprints it first (which doesn't change
// its own status, just adds reprint_note — so an interrupted job an owner
// cares about should be reprinted promptly, within that window, same as
// the existing "the stored file must still exist" constraint on reprinting
// print_failed jobs already implies).
const TERMINAL_STATUSES: JobStatus[] = ["printed", "print_failed", "payment_failed", "expired", "cancelled", "interrupted"];

// Maps between our camelCase record shape and the snake_case `print_jobs` table.
interface PrintJobRow {
  id: string;
  status: JobStatus;
  file_name: string;
  selected_pages: number[];
  settings: PrintSettingsSnapshot;
  total_price: number;
  phone_number: string;
  notify_opt_in: boolean;
  notified_at: string | null;
  include_banner_page: boolean;
  content_hash: string;
  provider: "cashfree" | "razorpay";
  provider_order_id: string;
  provider_meta: Record<string, string> | null;
  pdf_storage_path: string;
  kiosk_id: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  cups_job_id: string | null;
  blocked_reason: string | null;
  interrupted_reason: string | null;
  interrupted_at: string | null;
  original_job_id: string | null;
  reprint_note: string | null;
  pickup_mode: "here" | "later";
  force_cover_sheet: boolean;
  sheet_kind: "none" | "separator" | "cover" | null;
  collected_at: string | null;
  collected_via: "customer" | "staff" | null;
  refunded_at: string | null;
  refund_status: "pending" | "processing" | "refunded" | "failed" | "not_needed" | null;
  refund_requested_at: string | null;
  refunded_by: string | null;
  refund_provider_id: string | null;
  refund_error: string | null;
  ticket_number: number | null;
  ticket_date: string | null;
  payment_id: string | null;
  upi_txn_id: string | null;
  paid_amount: number | null;
  payment_method: "razorpay" | "cashfree" | "staff" | "reprint" | null;
  created_by_user_id: string | null;
  is_free: boolean | null;
  waived_amount: number | null;
  idempotency_key: string | null;
  queue_time: string | null;
  claimed_at: string | null;
  spooled_at: string | null;
  printer_idle_at: string | null;
  ready_at: string | null;
}

function fromRow(row: PrintJobRow): PrintJobRecord {
  return {
    id: row.id,
    status: row.status,
    fileName: row.file_name,
    selectedPages: row.selected_pages,
    settings: row.settings,
    totalPrice: row.total_price,
    phoneNumber: row.phone_number,
    notifyOptIn: row.notify_opt_in,
    notifiedAt: row.notified_at ?? undefined,
    includeBannerPage: row.include_banner_page,
    contentHash: row.content_hash,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerMeta: row.provider_meta ?? undefined,
    pdfStoragePath: row.pdf_storage_path,
    kioskId: row.kiosk_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
    cupsJobId: row.cups_job_id ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
    interruptedReason: row.interrupted_reason ?? undefined,
    interruptedAt: row.interrupted_at ?? undefined,
    originalJobId: row.original_job_id ?? undefined,
    reprintNote: row.reprint_note ?? undefined,
    pickupMode: row.pickup_mode,
    forceCoverSheet: row.force_cover_sheet,
    sheetKind: row.sheet_kind ?? undefined,
    collectedAt: row.collected_at ?? undefined,
    collectedVia: row.collected_via ?? undefined,
    refundedAt: row.refunded_at ?? undefined,
    refundStatus: row.refund_status ?? undefined,
    refundRequestedAt: row.refund_requested_at ?? undefined,
    refundedBy: row.refunded_by ?? undefined,
    refundProviderId: row.refund_provider_id ?? undefined,
    refundError: row.refund_error ?? undefined,
    ticketNumber: row.ticket_number ?? undefined,
    ticketDate: row.ticket_date ?? undefined,
    paymentId: row.payment_id ?? undefined,
    upiTxnId: row.upi_txn_id ?? undefined,
    paidAmount: row.paid_amount ?? undefined,
    paymentMethod: row.payment_method ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    isFree: row.is_free ?? undefined,
    waivedAmount: row.waived_amount ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    queueTime: row.queue_time ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    spooledAt: row.spooled_at ?? undefined,
    printerIdleAt: row.printer_idle_at ?? undefined,
    readyAt: row.ready_at ?? undefined,
  };
}

function toInsertRow(job: PrintJobRecord): Partial<PrintJobRow> {
  return {
    id: job.id,
    status: job.status,
    file_name: job.fileName,
    selected_pages: job.selectedPages,
    settings: job.settings,
    total_price: job.totalPrice,
    phone_number: job.phoneNumber,
    notify_opt_in: job.notifyOptIn,
    include_banner_page: job.includeBannerPage,
    content_hash: job.contentHash,
    provider: job.provider,
    provider_order_id: job.providerOrderId,
    provider_meta: job.providerMeta ?? null,
    pdf_storage_path: job.pdfStoragePath,
    kiosk_id: job.kioskId,
    ticket_number: job.ticketNumber ?? null,
    ticket_date: job.ticketDate ?? null,
    pickup_mode: job.pickupMode ?? "here",
    force_cover_sheet: job.forceCoverSheet ?? false,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

/**
 * `blockedReason` is the one field updateJob callers legitimately need to
 * CLEAR (set back to null) once a job stops being print_blocked, not just
 * set — every other optional PrintJobRecord field only ever gets set once
 * and never explicitly nulled back out through this path, hence the
 * widened type just for this one. `Omit` first, not a plain `&`
 * intersection — intersecting two object types that both declare the same
 * optional property computes the INTERSECTION of its two value types
 * (`(string | undefined) & (string | null)` collapses to just `string`,
 * silently dropping `null` again), not an override.
 */
type JobPatch = Omit<Partial<PrintJobRecord>, "blockedReason"> & { blockedReason?: string | null };

function toUpdateRow(patch: JobPatch): Partial<PrintJobRow> {
  const row: Partial<PrintJobRow> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.providerOrderId !== undefined) row.provider_order_id = patch.providerOrderId;
  if (patch.providerMeta !== undefined) row.provider_meta = patch.providerMeta;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.cupsJobId !== undefined) row.cups_job_id = patch.cupsJobId;
  if (patch.blockedReason !== undefined) row.blocked_reason = patch.blockedReason;
  if (patch.refundedAt !== undefined) row.refunded_at = patch.refundedAt;
  if (patch.paymentId !== undefined) row.payment_id = patch.paymentId;
  if (patch.upiTxnId !== undefined) row.upi_txn_id = patch.upiTxnId;
  if (patch.paidAmount !== undefined) row.paid_amount = patch.paidAmount;
  if (patch.spooledAt !== undefined) row.spooled_at = patch.spooledAt;
  if (patch.printerIdleAt !== undefined) row.printer_idle_at = patch.printerIdleAt;
  if (patch.readyAt !== undefined) row.ready_at = patch.readyAt;
  if (patch.sheetKind !== undefined) row.sheet_kind = patch.sheetKind;
  return row;
}

export async function createJob(job: PrintJobRecord): Promise<void> {
  const { error } = await supabaseAdmin().from("print_jobs").insert(toInsertRow(job));
  if (error) throw new Error(`Could not create job: ${error.message}`);
}

/**
 * Atomically assigns the next short pickup code for a kiosk's current day
 * (ROADMAP.md §21) — call this once, before createJob, and stamp the result
 * onto the job record being inserted. Wraps the next_ticket_number()
 * Postgres function, which does the actual atomic increment; see that
 * function's comment in supabase/schema.sql for why it returns the date it
 * used alongside the number instead of leaving the caller to compute it.
 */
export async function assignTicketNumber(kioskId: string): Promise<{ ticketNumber: number; ticketDate: string }> {
  const { data, error } = await supabaseAdmin().rpc("next_ticket_number", { p_kiosk_id: kioskId });
  if (error || !data || data.length === 0) {
    throw new Error(`Could not assign ticket number: ${error?.message || "no row returned"}`);
  }
  const row = data[0] as { ticket_number: number; ticket_date: string };
  return { ticketNumber: row.ticket_number, ticketDate: row.ticket_date };
}

export async function getJob(jobId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin().from("print_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error) throw new Error(`Could not fetch job: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

export async function updateJob(jobId: string, patch: JobPatch): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update(toUpdateRow(patch))
    .eq("id", jobId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not update job: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

/**
 * Atomically confirms payment: only succeeds if the job is still
 * `pending_payment`. Two independent callers can race to confirm the same
 * job — the customer's own browser polling and the scheduled recheck (see
 * ROADMAP.md #9) — so this uses the same atomic UPDATE ... WHERE pattern as
 * every other claim in this file, rather than a read-then-write, to
 * guarantee only one of them ever wins and only that one sends the
 * payment-confirmed notification (see lib/payment-reconciliation.ts and
 * ROADMAP.md §11). A database trigger (see the staff-print migration)
 * stamps `queue_time` automatically the instant this UPDATE takes a job's
 * status to 'paid' — nothing below needs to set it itself.
 */
export async function claimJobAsPaid(jobId: string, providerMeta: Record<string, string>): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ status: "paid", provider_meta: providerMeta, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending_payment")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not claim job as paid: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

/** Same atomic guard as claimJobAsPaid — never overwrite a job another caller already moved to "paid". */
export async function expireJobIfPending(jobId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending_payment")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not expire job: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

/**
 * The ONE place a job is ever marked print_failed — a plain `updateJob`
 * call here would be a real, confirmed bug: "a job can be both failed and
 * printed." A job's print agent can discover a genuine, unrecoverable
 * problem (or a generous retry/blocked-time budget running out) at the
 * exact same moment the PHYSICAL printer — independently, e.g. a
 * multi-copy job already fully buffered on this printer's own USB/SPL
 * hardware — actually finishes it, or some other path has already moved
 * it to 'printed'. The atomic `WHERE status IN ('printing','print_blocked')`
 * guard means this can only ever fail a job that is STILL, right now,
 * genuinely in progress — if it's already 'printed' (or already
 * 'print_failed', 'cancelled', anything else), this updates zero rows and
 * returns null, and the caller (print-agent/index.ts) must treat that as
 * "someone/something already resolved this, leave it alone" — never retry
 * the write, never log it as an unexpected error.
 *
 * Clears blocked_reason back to null in the same statement — a failed job
 * is no longer "waiting," it's done (and now a candidate for
 * set_print_job_refund_pending's own trigger, via the status change
 * itself).
 */
export async function failPrintingJob(jobId: string, reason: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ status: "print_failed", error: reason, blocked_reason: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["printing", "print_blocked"])
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not mark job print_failed: ${error.message}`);
  const job = data ? fromRow(data as PrintJobRow) : null;

  // Durable failure-rate ledger for get_kiosk_sales_summary (supabase/migrations/2026-10-21_sales_stats.sql)
  // — print_jobs itself gets cleaned up a few hours after this resolves
  // (see get_kiosk_period_breakdown's own comment), so this has to be
  // logged here, at the one place a job is ever actually marked
  // print_failed, not derived later from print_jobs. Only logged when this
  // call is the one that actually caused the transition (job !== null) —
  // never for a call that found the job already resolved.
  if (job) {
    const { error: logError } = await supabaseAdmin().from("print_failures").insert({ kiosk_id: job.kioskId, job_id: jobId });
    if (logError) console.error("Failed to log print_failures entry:", logError.message);
  }

  return job;
}

/**
 * The ONE place a job is ever marked 'interrupted' — same atomic
 * `WHERE status IN ('printing','print_blocked')` guard as failPrintingJob
 * above, for the identical reason: called only from print-agent/index.ts's
 * boot reconciliation, which runs once at startup, but there is no harm in
 * (and real defense-in-depth from) making it refuse to touch a job that
 * somehow isn't in one of those two states anymore by the time it runs.
 */
export async function markJobInterrupted(jobId: string, reason: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ status: "interrupted", interrupted_reason: reason, interrupted_at: new Date().toISOString(), blocked_reason: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["printing", "print_blocked"])
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not mark job interrupted: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

/**
 * Every job THIS kiosk's print agent still had "in flight" (printing or
 * print_blocked) — checked once at boot, before the normal poll loop
 * starts, to reconcile anything the agent's own previous process never got
 * to finish watching (see print-agent/index.ts's reconcileInFlightJobsOnBoot).
 * Scoped to one kiosk, same as every other kiosk-scoped query here — each
 * Pi only ever owns its own kiosk's rows.
 */
export async function listInFlightJobsForKiosk(kioskId: string): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("kiosk_id", kioskId)
    .in("status", ["printing", "print_blocked"]);
  if (error) throw new Error(`Could not list in-flight jobs: ${error.message}`);
  return (data as PrintJobRow[]).map(fromRow);
}

/** Used by the scheduled payment recheck (ROADMAP.md #9) to sweep every kiosk's unconfirmed jobs, not just one. */
export async function listPendingPaymentJobs(): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("status", "pending_payment");
  if (error) throw new Error(`Could not list pending-payment jobs: ${error.message}`);
  return (data as PrintJobRow[]).map(fromRow);
}

/**
 * Atomically claims a job for WhatsApp notification: only succeeds if
 * notified_at is still null. Same atomic UPDATE ... WHERE pattern as
 * claimJobAsPaid above — app/api/agent/notify calls
 * this before ever sending anything, so a retried or duplicate call from
 * the print agent (it's allowed to call this endpoint more than once per
 * job, see that route's own comment) can never result in two WhatsApp
 * messages for the same job.
 */
export async function claimJobForNotification(jobId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", jobId)
    .is("notified_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not claim job for notification: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

/**
 * Atomically claims the single oldest ready-to-print job at a kiosk —
 * "oldest" meaning the earliest `queue_time`, the single timestamp a
 * database trigger stamps on EVERY job (staff or paying customer, whichever
 * path got it to 'paid') the instant it first becomes 'paid', not
 * `created_at` — so a job that sat in pending_payment for three minutes
 * before paying never queue-jumps a staff print that was ready to print ten
 * seconds ago, and neither job type is ever preferred over the other.
 *
 * Wraps claim_next_paid_job(), a single `SELECT ... FOR UPDATE SKIP LOCKED`
 * + `UPDATE ... WHERE status = 'paid'` Postgres function — see that
 * function's own comment in the staff-print migration for why this
 * replaces the print agent's old "list every paid job, then claim each one
 * individually" pattern: claiming is now part of the same atomic operation
 * as picking which job is next, so two agent processes (or an agent
 * restart briefly overlapping its own old process) can never both claim
 * the same row, and the processing order is never left to depend on
 * whatever order Postgres happened to return an unordered SELECT in.
 *
 * Call this in a loop (see print-agent/index.ts's pollLoop) until it
 * returns null — that's "no more ready jobs at this kiosk right now."
 */
export async function claimNextPaidJob(kioskId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin().rpc("claim_next_paid_job", { p_kiosk_id: kioskId });
  if (error) throw new Error(`Could not claim next paid job: ${error.message}`);
  const rows = data as PrintJobRow[] | null;
  return rows && rows.length > 0 ? fromRow(rows[0]) : null;
}

export interface CreateStaffPrintJobInput {
  jobId: string;
  fileName: string;
  selectedPages: number[];
  settings: PrintSettingsSnapshot;
  /** The price this job WOULD have cost a paying customer — computed server-side (app/api/staff-print/route.ts) from the real pricing rules, never from anything the client claims. */
  waivedAmount: number;
  contentHash: string;
  /** Which gateway is "active" right now (getActiveProvider()) — stamped onto this job's `provider` column for schema consistency even though it's never meaningful for a staff job (no gateway order exists); `paymentMethod` is the real source of truth, see PrintJobRecord's own comment. */
  provider: "cashfree" | "razorpay";
  pdfStoragePath: string;
  kioskId: string;
  /** Deduplicates a retried/double-clicked submission against the SAME earlier attempt — enforced by a partial unique index (idempotency_key), not just this app-level field. */
  idempotencyKey: string | null;
  createdByUserId: string;
  dailyCap: number;
  forceCoverSheet: boolean;
}

/**
 * Creates a staff/owner print job and marks it paid in one atomic Postgres
 * transaction (wraps create_staff_print_job()) — a job can never be left
 * half-created the way two separate app-level calls (assign a ticket
 * number, then insert a row) could leave one if the second step failed.
 * Also handles idempotency (a retried/double-clicked submission with the
 * same idempotencyKey resolves to the already-created job) and the atomic
 * daily page-cap check/increment — see that function's own comment in the
 * staff-print migration for exactly how.
 *
 * Throws on a genuine failure (including "over the daily cap," which the
 * RPC raises as a Postgres exception) — the caller (app/api/staff-print)
 * is responsible for turning that into a clear, customer-safe error message.
 */
export async function createStaffPrintJob(input: CreateStaffPrintJobInput): Promise<PrintJobRecord> {
  const { data, error } = await supabaseAdmin().rpc("create_staff_print_job", {
    p_job_id: input.jobId,
    p_file_name: input.fileName,
    p_selected_pages: input.selectedPages,
    p_settings: input.settings,
    p_waived_amount: input.waivedAmount,
    p_content_hash: input.contentHash,
    p_provider: input.provider,
    p_pdf_storage_path: input.pdfStoragePath,
    p_kiosk_id: input.kioskId,
    p_idempotency_key: input.idempotencyKey,
    p_created_by: input.createdByUserId,
    p_daily_cap: input.dailyCap,
    p_force_cover_sheet: input.forceCoverSheet,
  });
  if (error) throw new Error(`Could not create staff print job: ${error.message}`);
  const rows = data as PrintJobRow[] | null;
  if (!rows || rows.length === 0) throw new Error("create_staff_print_job returned no row.");
  return fromRow(rows[0]);
}

export interface CreateReprintJobInput {
  jobId: string;
  originalJobId: string;
  selectedPages: number[];
  settings: PrintSettingsSnapshot;
  includeBannerPage: boolean;
  contentHash: string;
  pdfStoragePath: string;
  createdByUserId: string;
  reprintNote: string;
  forceCoverSheet: boolean;
}

/**
 * Creates a free "reprint pages" job linked to an earlier one (requirement:
 * "Submitting creates a NEW linked job (original_job_id, reason =
 * reprint)") — wraps create_reprint_job(), one atomic Postgres transaction
 * that: re-checks the original job isn't already refunded (the real,
 * authoritative check — app/api/admin/reprint's own upfront check is just a
 * faster-failing UX nicety), assigns a ticket number from the SAME sequence
 * every other job uses, inserts the new row already 'paid', writes the
 * "reprinted pages X to Y" note onto the ORIGINAL job, and writes one audit
 * entry — all or nothing, so this can never leave the original job noted as
 * reprinted without the new job actually existing, or vice versa.
 *
 * Throws on a genuine failure (including "already refunded," which the RPC
 * raises as a Postgres exception) — the caller (app/api/admin/reprint) is
 * responsible for turning that into a clear, owner-facing error message.
 */
export async function createReprintJob(input: CreateReprintJobInput): Promise<PrintJobRecord> {
  const { data, error } = await supabaseAdmin().rpc("create_reprint_job", {
    p_job_id: input.jobId,
    p_original_job_id: input.originalJobId,
    p_selected_pages: input.selectedPages,
    p_settings: input.settings,
    p_include_banner_page: input.includeBannerPage,
    p_content_hash: input.contentHash,
    p_pdf_storage_path: input.pdfStoragePath,
    p_reprint_note: input.reprintNote,
    p_created_by: input.createdByUserId,
    p_force_cover_sheet: input.forceCoverSheet,
  });
  if (error) throw new Error(`Could not create reprint job: ${error.message}`);
  const rows = data as PrintJobRow[] | null;
  if (!rows || rows.length === 0) throw new Error("create_reprint_job returned no row.");
  return fromRow(rows[0]);
}

export function pdfStoragePathForJob(jobId: string): string {
  return `${jobId}.pdf`;
}

export async function uploadJobPdf(jobId: string, bytes: Uint8Array): Promise<string> {
  const path = pdfStoragePathForJob(jobId);
  const { error } = await supabaseAdmin()
    .storage.from(SUPABASE_PRINT_BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`Could not upload print PDF: ${error.message}`);
  return path;
}

export async function downloadJobPdf(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin().storage.from(SUPABASE_PRINT_BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Could not download print PDF: ${error?.message || "not found"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Short-lived signed URL for the admin "Reprint pages" modal to download an
 * EXISTING job's own stored PDF directly into the browser (so it can reuse
 * the same client-side thumbnail pipeline — lib/hooks/useFileBasket.ts —
 * every other page in this app already uses, rather than duplicating that
 * logic server-side). Mirrors createTempUploadUrl's shape but for reading,
 * not writing (createSignedUrl, not createSignedUploadUrl). Throws if the
 * object doesn't exist — the caller (app/api/admin/jobs/[jobId]/pdf-url)
 * turns that into "the file was removed and can't be reprinted," per
 * requirement #5.
 */
export async function createJobPdfDownloadUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
  const { data, error } = await supabaseAdmin().storage.from(SUPABASE_PRINT_BUCKET).createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data) throw new Error(`Could not create a download URL: ${error?.message || "file not found"}`);
  return data.signedUrl;
}

// ----------------------------------------------------------------------------
// Direct-to-storage uploads — the customer's browser uploads straight to
// Supabase Storage via a signed URL (app/api/create-upload-url), never
// through /api/create-order's own request body. That route previously
// received the full PDF as multipart form data, which hit Vercel's ~4.5MB
// serverless function request-body limit well under the app's own
// (client-side-only, never actually enforced server-side at the transport
// layer) file-size ceiling — a 6.5MB upload failed with an opaque 413
// before any of this app's own code ever ran. Everything below exists so
// the only thing that ever crosses into a Vercel function is JSON metadata
// and a storage path, regardless of how large the actual file is.
// ----------------------------------------------------------------------------

/** Separate from job-id-keyed final paths ("<jobId>.pdf", pdfStoragePathForJob above) so a raw, not-yet-validated upload can never collide with — or be mistaken for — an actual job's print-ready file. */
const TEMP_UPLOAD_PREFIX = "uploads/";

export function tempUploadStoragePath(uploadId: string): string {
  return `${TEMP_UPLOAD_PREFIX}${uploadId}.pdf`;
}

/**
 * Issues a signed upload URL + token for a temp path (app/api/create-upload-url)
 * — the customer's browser then uploads directly to Supabase Storage with
 * it, never touching our own server. Requires only the service-role key
 * (bypasses RLS to create it); the signed token itself is what authorizes
 * the subsequent upload, not any bucket policy — see createSignedUploadUrl's
 * own "RLS policy permissions required: objects table permissions: insert"
 * note, satisfied here by the service-role client regardless.
 */
export async function createTempUploadUrl(path: string): Promise<{ signedUrl: string; token: string }> {
  const { data, error } = await supabaseAdmin().storage.from(SUPABASE_PRINT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`Could not create upload URL: ${error?.message || "no data returned"}`);
  return { signedUrl: data.signedUrl, token: data.token };
}

/** Best-effort single-object delete — used for a temp upload that turned out invalid, was already consumed into a job's final PDF, or (see listStaleTempUploads) was abandoned. Never throws; a leaked temp object is a storage-cost nuisance, not a correctness problem, and the caller's own flow (rejecting an order, say) matters more than this cleanup succeeding. */
export async function deleteStorageObject(path: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(SUPABASE_PRINT_BUCKET).remove([path]);
  if (error) console.error(`Could not delete storage object ${path}:`, error.message);
}

/**
 * Orphaned temp uploads: a signed URL was issued and used, but
 * /api/create-order was never (successfully) called afterward — the
 * customer closed the tab mid-checkout, a request failed, etc. Used by
 * /api/cron/cleanup-jobs, which otherwise only ever looks at print_jobs
 * rows and would never notice a file that no row ever referenced.
 * Age-based, not job-linked, by necessity: nothing in Postgres tracks these
 * at all (deliberately — a temp upload isn't a job yet), so the Storage
 * object's own created_at is the only signal available.
 */
export async function listStaleTempUploads(olderThanMs: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .storage.from(SUPABASE_PRINT_BUCKET)
    .list(TEMP_UPLOAD_PREFIX, { limit: 1000, sortBy: { column: "created_at", order: "asc" } });
  if (error) throw new Error(`Could not list temp uploads: ${error.message}`);

  const cutoff = Date.now() - olderThanMs;
  return (data ?? [])
    .filter((entry) => entry.created_at && new Date(entry.created_at).getTime() < cutoff)
    // list() returns names relative to the prefix passed in — the actual
    // object path (what remove() needs) has to have it put back.
    .map((entry) => `${TEMP_UPLOAD_PREFIX}${entry.name}`);
}

/**
 * Jobs eligible for auto-delete (ROADMAP.md #4): terminal-state jobs past
 * their short retention window, plus pending_payment jobs old enough to
 * count as genuinely abandoned. Deliberately excludes `paid`/`printing` —
 * those are still active regardless of age, see ROADMAP.md §11's
 * file-cleanup-vs-stuck-job note (a kiosk offline for a day shouldn't come
 * back to its queued job's PDF deleted out from under it).
 *
 * Also excludes a print_failed job whose refund is still unresolved
 * (refund_status 'pending', 'processing', or 'failed') — TERMINAL_JOB_RETENTION_HOURS
 * is only 6 hours, far shorter than an owner might reasonably take to
 * review a refund queue, and this cron runs unconditionally regardless of
 * whether anyone's looked at it yet. Without this, a job an owner hasn't
 * gotten to refunding yet could have its row (and the only record of what
 * was owed) deleted out from under the Refunds admin page. A row only
 * becomes eligible again once refund_status is null (never needed one),
 * 'refunded' (resolved), or 'not_needed' (an owner reprinted it instead —
 * see set_original_job_refund_not_needed) — never while real money is
 * still owed or a refund attempt is actively in flight.
 */
export async function listJobsEligibleForCleanup(): Promise<PrintJobRecord[]> {
  const terminalCutoff = new Date(Date.now() - TERMINAL_JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const abandonedCutoff = new Date(Date.now() - ABANDONED_JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const [terminalResult, abandonedResult] = await Promise.all([
    supabaseAdmin()
      .from("print_jobs")
      .select("*")
      .in("status", TERMINAL_STATUSES)
      .lt("updated_at", terminalCutoff)
      .or("refund_status.is.null,refund_status.eq.refunded,refund_status.eq.not_needed"),
    supabaseAdmin().from("print_jobs").select("*").eq("status", "pending_payment").lt("created_at", abandonedCutoff),
  ]);

  if (terminalResult.error) throw new Error(`Could not list terminal jobs for cleanup: ${terminalResult.error.message}`);
  if (abandonedResult.error) throw new Error(`Could not list abandoned jobs for cleanup: ${abandonedResult.error.message}`);

  return [...(terminalResult.data as PrintJobRow[]), ...(abandonedResult.data as PrintJobRow[])].map(fromRow);
}

/**
 * Deletes a job's row and its Storage object — but only if the job's status
 * is still exactly what the caller last saw it as. Guards against a real
 * race with the payment-recheck cron (ROADMAP.md #9): a pending_payment job
 * could flip to `paid` in the gap between listJobsEligibleForCleanup's
 * SELECT and this DELETE, and without this guard it would get deleted
 * anyway — precisely the stuck-job-vs-cleanup race flagged in ROADMAP.md
 * §11. The row delete itself is the atomic check (same `UPDATE/DELETE ...
 * WHERE status = X` discipline as claimJobAsPaid/expireJobIfPending); if
 * zero rows match, something else already moved the job on and this backs
 * off without touching Storage.
 *
 * Returns whether the job was actually deleted, so the caller can report
 * accurate counts.
 */
export async function deleteJob(job: Pick<PrintJobRecord, "id" | "status" | "pdfStoragePath">): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .delete()
    .eq("id", job.id)
    .eq("status", job.status)
    .select("id");
  if (error) throw new Error(`Could not delete job ${job.id}: ${error.message}`);

  const wasDeleted = (data?.length ?? 0) > 0;
  if (!wasDeleted) return false;

  // Storage removal is best-effort — the row is already gone at this point,
  // so a failure here just leaves an orphaned Storage object rather than a
  // dangling row with nowhere to retry from.
  const { error: storageError } = await supabaseAdmin().storage.from(SUPABASE_PRINT_BUCKET).remove([job.pdfStoragePath]);
  if (storageError) console.error(`Could not delete storage object for job ${job.id}:`, storageError.message);

  return true;
}

/**
 * Duplicate-submission protection (ROADMAP.md #13) — finds a very recent job
 * with byte-identical uploaded content, the same settings, and the same
 * price, that's still in a state where re-showing its existing order makes
 * sense (`pending_payment` or `paid`, and already has a real gateway order
 * attached). Used by /api/create-order to make a double-click or a flaky
 * retry idempotent instead of creating a second paid order for one upload.
 *
 * Best-effort, not a hard lock: two truly simultaneous requests can still
 * both pass this check before either finishes creating its job (there's no
 * atomic claim here, unlike the payment/printing state transitions) — an
 * acceptable gap for a UX-level protection against double-clicks/retries,
 * not a correctness-critical guarantee like those atomic transitions are.
 */
export async function findRecentDuplicateJob(input: {
  contentHash: string;
  totalPrice: number;
  settings: PrintSettingsSnapshot;
  windowSeconds: number;
}): Promise<PrintJobRecord | null> {
  const cutoff = new Date(Date.now() - input.windowSeconds * 1000).toISOString();
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("content_hash", input.contentHash)
    .eq("total_price", input.totalPrice)
    .in("status", ["pending_payment", "paid"])
    .neq("provider_order_id", "")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(`Could not check for a duplicate order: ${error.message}`);

  const candidates = (data as PrintJobRow[]).map(fromRow);
  return candidates.find((candidate) => settingsMatch(candidate.settings, input.settings)) ?? null;
}

/**
 * Field-by-field, not JSON.stringify comparison — candidate.settings comes
 * back from a Postgres jsonb column, which does not guarantee preserving
 * the original key order, so two semantically-identical settings objects
 * can stringify differently after a jsonb round-trip. Exported for direct
 * testing (see store.test.ts) — this is exactly the regression a
 * JSON.stringify comparison would silently reintroduce.
 */
export function settingsMatch(a: PrintSettingsSnapshot, b: PrintSettingsSnapshot): boolean {
  return a.copies === b.copies
    && a.layout === b.layout
    && a.isColor === b.isColor
    && a.paperSize === b.paperSize
    && a.pagesPerSheet === b.pagesPerSheet;
}

/**
 * Jobs still queued ahead of this one at the same kiosk — used by
 * lib/eta.ts (ROADMAP.md #3). "Ahead" means still active (paid/printing/
 * print_blocked, same as what the print agent itself watches for) and
 * created before this job, since the print agent works through paid jobs
 * roughly in arrival order. print_blocked counts as "ahead" too — it's
 * still occupying the printer and every job behind it in queue genuinely
 * has to wait for it to resolve one way or another.
 */
export async function listJobsAheadInQueue(job: Pick<PrintJobRecord, "id" | "kioskId" | "createdAt">): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("kiosk_id", job.kioskId)
    .in("status", ["paid", "printing", "print_blocked"])
    .lt("created_at", job.createdAt)
    .neq("id", job.id);
  if (error) throw new Error(`Could not list jobs ahead in queue: ${error.message}`);
  return (data as PrintJobRow[]).map(fromRow);
}

export async function markJobCollected(jobId: string, via: "customer" | "staff"): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ collected_at: new Date().toISOString(), collected_via: via, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "printed")
    .is("collected_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not mark job collected: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

export async function isTrayLikelyOccupied(kioskId: string, now: Date, config: { recentJobMinutes: number; laterHoldHours: number }): Promise<boolean> {
  const { data: kiosk, error: kioskError } = await supabaseAdmin().from("kiosk_status").select("tray_cleared_at").eq("id", kioskId).maybeSingle();
  if (kioskError) throw new Error(`Could not read kiosk tray state: ${kioskError.message}`);
  const trayClearedAt = (kiosk as { tray_cleared_at: string | null } | null)?.tray_cleared_at ?? null;

  const laterCutoff = new Date(now.getTime() - config.laterHoldHours * 3600_000).toISOString();
  const hereCutoff = new Date(now.getTime() - config.recentJobMinutes * 60_000).toISOString();

  let query = supabaseAdmin()
    .from("print_jobs")
    .select("id")
    .eq("kiosk_id", kioskId)
    .eq("status", "printed")
    .is("collected_at", null)
    .or(`and(pickup_mode.eq.later,ready_at.gte.${laterCutoff}),and(pickup_mode.eq.here,ready_at.gte.${hereCutoff})`)
    .limit(1);
  if (trayClearedAt) query = query.gt("ready_at", trayClearedAt);

  const { data, error } = await query;
  if (error) throw new Error(`Could not check tray occupancy: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function countUncollectedPrintedJobs(kioskId: string, trayClearedAt: string | null): Promise<number> {
  let query = supabaseAdmin()
    .from("print_jobs")
    .select("id", { count: "exact", head: true })
    .eq("kiosk_id", kioskId)
    .eq("status", "printed")
    .is("collected_at", null);
  if (trayClearedAt) query = query.gt("ready_at", trayClearedAt);

  const { count, error } = await query;
  if (error) throw new Error(`Could not count uncollected jobs: ${error.message}`);
  return count ?? 0;
}

export async function listUncollectedJobsAheadInTray(kioskId: string, trayClearedAt: string | null, beforeReadyAt: string): Promise<PrintJobRecord[]> {
  let query = supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("kiosk_id", kioskId)
    .eq("status", "printed")
    .is("collected_at", null)
    .lt("ready_at", beforeReadyAt)
    .order("ready_at", { ascending: true });
  if (trayClearedAt) query = query.gt("ready_at", trayClearedAt);

  const { data, error } = await query;
  if (error) throw new Error(`Could not list jobs ahead in tray: ${error.message}`);
  return (data as PrintJobRow[]).map(fromRow);
}

export interface PricingConfig {
  priceBw: number;
  priceColor: number;
}

/**
 * Owner-editable per-sheet pricing (ROADMAP.md #6). Read here with the
 * service-role client for /api/create-order's server-side price
 * recalculation — separate from the admin panel's own RLS-gated read/write
 * of the same table (owner-only there; this read bypasses RLS like every
 * other service-role call in this file, which is fine since it's the
 * source of truth the server trusts, not a customer-facing read).
 */
export async function getPricingConfig(): Promise<PricingConfig> {
  const { data, error } = await supabaseAdmin()
    .from("pricing_config")
    .select("price_bw, price_color")
    .eq("id", "default")
    .single();
  if (error || !data) throw new Error(`Could not load pricing config: ${error?.message || "not found"}`);
  return { priceBw: Number(data.price_bw), priceColor: Number(data.price_color) };
}
