import { supabaseAdmin } from "./supabase-admin";
import { SUPABASE_PRINT_BUCKET } from "./config";

export type JobStatus =
  | "pending_payment"
  | "paid"
  | "printing"
  | "printed"
  | "print_failed"
  | "payment_failed"
  | "expired";

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
  provider: "cashfree" | "razorpay";
  /** Gateway's own order id, used to look the job up from webhooks and polling. */
  providerOrderId: string;
  providerMeta?: Record<string, string>;
  /** Path inside SUPABASE_PRINT_BUCKET where the final, print-ready PDF lives. */
  pdfStoragePath: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  cupsJobId?: string;
}

// Maps between our camelCase record shape and the snake_case `print_jobs` table
// (see SUPABASE_SETUP.md for the schema).
interface PrintJobRow {
  id: string;
  status: JobStatus;
  file_name: string;
  selected_pages: number[];
  settings: PrintSettingsSnapshot;
  total_price: number;
  provider: "cashfree" | "razorpay";
  provider_order_id: string;
  provider_meta: Record<string, string> | null;
  pdf_storage_path: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  cups_job_id: string | null;
}

function fromRow(row: PrintJobRow): PrintJobRecord {
  return {
    id: row.id,
    status: row.status,
    fileName: row.file_name,
    selectedPages: row.selected_pages,
    settings: row.settings,
    totalPrice: row.total_price,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerMeta: row.provider_meta ?? undefined,
    pdfStoragePath: row.pdf_storage_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
    cupsJobId: row.cups_job_id ?? undefined,
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
    provider: job.provider,
    provider_order_id: job.providerOrderId,
    provider_meta: job.providerMeta ?? null,
    pdf_storage_path: job.pdfStoragePath,
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
  return row;
}

export async function createJob(job: PrintJobRecord): Promise<void> {
  const { error } = await supabaseAdmin().from("print_jobs").insert(toInsertRow(job));
  if (error) throw new Error(`Could not create job: ${error.message}`);
}

export async function getJob(jobId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin().from("print_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error) throw new Error(`Could not fetch job: ${error.message}`);
  return data ? fromRow(data as PrintJobRow) : null;
}

export async function findJobByProviderOrderId(providerOrderId: string): Promise<PrintJobRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .eq("provider_order_id", providerOrderId)
    .maybeSingle();
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

export async function listPaidJobs(): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin().from("print_jobs").select("*").eq("status", "paid");
  if (error) throw new Error(`Could not list paid jobs: ${error.message}`);
  return (data as PrintJobRow[]).map(fromRow);
}

export async function listJobs(): Promise<PrintJobRecord[]> {
  const { data, error } = await supabaseAdmin()
    .from("print_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not list jobs: ${error.message}`);
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
