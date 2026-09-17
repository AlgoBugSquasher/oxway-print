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
  | "cancelled";

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
  /** Customer's phone number, collected at checkout — see ROADMAP.md #1. */
  phoneNumber: string;
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
  /** Set when an owner marks a failed/cancelled job refunded from the admin panel (ROADMAP.md #6). Independent of `status` — a job's payment/print outcome and its refund state are two separate facts. */
  refundedAt?: string;
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
}

const TERMINAL_STATUSES: JobStatus[] = ["printed", "print_failed", "payment_failed", "expired", "cancelled"];

// Maps between our camelCase record shape and the snake_case `print_jobs` table.
interface PrintJobRow {
  id: string;
  status: JobStatus;
  file_name: string;
  selected_pages: number[];
  settings: PrintSettingsSnapshot;
  total_price: number;
  phone_number: string;
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
  refunded_at: string | null;
  ticket_number: number | null;
  ticket_date: string | null;
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
    refundedAt: row.refunded_at ?? undefined,
    ticketNumber: row.ticket_number ?? undefined,
    ticketDate: row.ticket_date ?? undefined,
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
    include_banner_page: job.includeBannerPage,
    content_hash: job.contentHash,
    provider: job.provider,
    provider_order_id: job.providerOrderId,
    provider_meta: job.providerMeta ?? null,
    pdf_storage_path: job.pdfStoragePath,
    kiosk_id: job.kioskId,
    ticket_number: job.ticketNumber ?? null,
    ticket_date: job.ticketDate ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

function toUpdateRow(patch: Partial<PrintJobRecord>): Partial<PrintJobRow> {
  const row: Partial<PrintJobRow> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.providerOrderId !== undefined) row.provider_order_id = patch.providerOrderId;
  if (patch.providerMeta !== undefined) row.provider_meta = patch.providerMeta;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.cupsJobId !== undefined) row.cups_job_id = patch.cupsJobId;
  if (patch.refundedAt !== undefined) row.refunded_at = patch.refundedAt;
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

export async function updateJob(jobId: string, patch: Partial<PrintJobRecord>): Promise<PrintJobRecord | null> {
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
 * claimJobForPrinting, rather than a read-then-write, to guarantee only one
 * of them ever wins and only that one sends the payment-confirmed
 * notification (see lib/payment-reconciliation.ts and ROADMAP.md §11).
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
 * Atomically claims a job for printing: only succeeds if it's still `paid`.
 * Used by the print agent so two agent instances (or an agent + a stray
 * retry) can never both print the same job.
 */
export async function claimJobForPrinting(jobId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .update({ status: "printing", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "paid")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not claim job: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

/** Scoped to a single kiosk — each Pi's print agent only ever sees its own jobs. */
export async function listPaidJobs(kioskId: string): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("status", "paid")
    .eq("kiosk_id", kioskId);
  if (error) throw new Error(`Could not list paid jobs: ${error.message}`);
  return (data as PrintJobRow[]).map(fromRow);
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
 * Jobs eligible for auto-delete (ROADMAP.md #4): terminal-state jobs past
 * their short retention window, plus pending_payment jobs old enough to
 * count as genuinely abandoned. Deliberately excludes `paid`/`printing` —
 * those are still active regardless of age, see ROADMAP.md §11's
 * file-cleanup-vs-stuck-job note (a kiosk offline for a day shouldn't come
 * back to its queued job's PDF deleted out from under it).
 */
export async function listJobsEligibleForCleanup(): Promise<PrintJobRecord[]> {
  const terminalCutoff = new Date(Date.now() - TERMINAL_JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const abandonedCutoff = new Date(Date.now() - ABANDONED_JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const [terminalResult, abandonedResult] = await Promise.all([
    supabaseAdmin().from("print_jobs").select("*").in("status", TERMINAL_STATUSES).lt("updated_at", terminalCutoff),
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
 * lib/eta.ts (ROADMAP.md #3). "Ahead" means still active (paid/printing,
 * same as what the print agent itself watches for) and created before this
 * job, since the print agent works through paid jobs roughly in arrival
 * order.
 */
export async function listJobsAheadInQueue(job: Pick<PrintJobRecord, "id" | "kioskId" | "createdAt">): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("kiosk_id", job.kioskId)
    .in("status", ["paid", "printing"])
    .lt("created_at", job.createdAt)
    .neq("id", job.id);
  if (error) throw new Error(`Could not list jobs ahead in queue: ${error.message}`);
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
