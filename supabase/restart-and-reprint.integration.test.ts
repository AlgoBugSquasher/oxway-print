import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for
 * supabase/migrations/2026-10-18_restart_and_reprint.sql — the part pure
 * unit tests can't verify: that the new columns/CHECK constraints
 * genuinely exist, that create_reprint_job's atomic re-check (refund
 * conflict) and role check (owner-only — "staff blocked") actually hold
 * against real PostgREST + Postgres, and that
 * set_original_job_refund_not_needed actually fires. The pure
 * restart-detection logic itself (lib/print/restart-reconciliation.ts)
 * and the reprint route's own validation (lib/print/reprint-note.ts, the
 * page-range/file-missing/refund-conflict checks in
 * app/api/admin/reprint/route.test.ts) are covered far more cheaply, with
 * no database at all — see those files for "interrupted detection after
 * restart," "reprint with a page range," "staff blocked," "deleted
 * file," and "refund conflict."
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-18_restart_and_reprint.sql to a
 *      DEV Supabase project — never production.
 *   2. Set these three env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *        STAFF_PRINT_TEST_SUPABASE_ANON_KEY=<anon/publishable key>
 *   3. Run: npx vitest run supabase/restart-and-reprint.integration.test.ts
 *
 * Every row/user this suite creates is scoped to its own randomly-
 * generated id, cleaned up in afterAll. Still: dev project only.
 */

const SUPABASE_URL = process.env.STAFF_PRINT_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_ANON_KEY;
const hasCredentials = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!hasCredentials) {
  console.warn(
    "[restart-and-reprint] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);
const SETTINGS = { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 };

describe.skipIf(!hasCredentials)("restart interrupted status + reprint pages (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerEmail: string;
  let staffEmail: string;
  let ownerUserId: string;
  let staffUserId: string;
  const kioskId = `test_reprint_${Date.now()}`;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: kioskId });

    ownerEmail = `reprint-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `reprint-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) {
      await admin.from("audit_log").delete().in("target_id", createdJobIds);
      await admin.from("print_jobs").delete().in("id", createdJobIds);
    }
    await admin.from("kiosk_status").delete().eq("id", kioskId);
    if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId);
    if (staffUserId) await admin.auth.admin.deleteUser(staffUserId);
  });

  async function signInAs(email: string): Promise<SupabaseClient> {
    const client = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
    if (error) throw error;
    return client;
  }

  async function createPaidJob(overrides: Record<string, unknown> = {}): Promise<string> {
    const jobId = crypto.randomUUID();
    const { error } = await admin.from("print_jobs").insert({
      id: jobId, status: "paid", file_name: "reprint-test.pdf", selected_pages: [1, 2, 3, 4, 5], settings: SETTINGS,
      total_price: 10, content_hash: `hash-${jobId}`, provider: "razorpay", provider_order_id: `order_${jobId}`,
      pdf_storage_path: `${jobId}.pdf`, kiosk_id: kioskId,
      ...overrides,
    });
    if (error) throw error;
    createdJobIds.push(jobId);
    return jobId;
  }

  it("print_jobs.interrupted_reason/interrupted_at exist and round-trip, surfaced via print_jobs_admin_view", async () => {
    const jobId = await createPaidJob({ status: "printing" });
    const { error: updateError } = await admin.from("print_jobs").update({
      status: "interrupted", interrupted_reason: "CUPS had no record of job oxway-1.", interrupted_at: new Date().toISOString(),
    }).eq("id", jobId);
    if (updateError) throw updateError;

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.from("print_jobs_admin_view").select("status, interrupted_reason, interrupted_at").eq("id", jobId).single();
    expect(error).toBeNull();
    expect(data!.status).toBe("interrupted");
    expect(data!.interrupted_reason).toBe("CUPS had no record of job oxway-1.");
    expect(data!.interrupted_at).not.toBeNull();
  });

  it("create_reprint_job: staff blocked — a staff session cannot call it at all (owner-only, unlike force_reprint_job)", async () => {
    const jobId = await createPaidJob({ status: "printed" });
    const staff = await signInAs(staffEmail);
    const { error } = await staff.rpc("create_reprint_job", {
      p_job_id: crypto.randomUUID(), p_original_job_id: jobId, p_selected_pages: [1, 2],
      p_settings: SETTINGS, p_include_banner_page: false, p_content_hash: "hash-x",
      p_pdf_storage_path: "x.pdf", p_reprint_note: "Reprinted pages 1 to 2 on test.", p_created_by: staffUserId,
    });
    expect(error).not.toBeNull();
  });

  it("create_reprint_job: refund conflict — blocks reprinting a job whose refund already completed", async () => {
    const jobId = await createPaidJob({ status: "print_failed", refund_status: "refunded", refunded_at: new Date().toISOString() });
    const owner = await signInAs(ownerEmail);
    const newJobId = crypto.randomUUID();
    const { error } = await owner.rpc("create_reprint_job", {
      p_job_id: newJobId, p_original_job_id: jobId, p_selected_pages: [1, 2],
      p_settings: SETTINGS, p_include_banner_page: false, p_content_hash: "hash-x",
      p_pdf_storage_path: `${newJobId}.pdf`, p_reprint_note: "Reprinted pages 1 to 2 on test.", p_created_by: ownerUserId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/already been refunded/i);

    const { data: newJobRow } = await admin.from("print_jobs").select("id").eq("id", newJobId).maybeSingle();
    expect(newJobRow).toBeNull(); // the whole transaction rolled back — no orphan row
  });

  it("create_reprint_job happy path: creates a linked, free, ticketed job and writes the note onto the original", async () => {
    const jobId = await createPaidJob({ status: "print_failed" });
    createdJobIds.push(jobId); // already pushed by createPaidJob, kept here for clarity
    const owner = await signInAs(ownerEmail);
    const newJobId = crypto.randomUUID();
    const { data, error } = await owner.rpc("create_reprint_job", {
      p_job_id: newJobId, p_original_job_id: jobId, p_selected_pages: [2, 3, 4],
      p_settings: { ...SETTINGS, copies: 2 }, p_include_banner_page: false, p_content_hash: "hash-x",
      p_pdf_storage_path: `${newJobId}.pdf`, p_reprint_note: "Reprinted pages 2 to 4 on test.", p_created_by: ownerUserId,
    });
    expect(error).toBeNull();
    createdJobIds.push(newJobId);

    const newJob = data?.[0];
    expect(newJob.status).toBe("paid");
    expect(newJob.total_price).toBe(0);
    expect(newJob.payment_method).toBe("reprint");
    expect(newJob.original_job_id).toBe(jobId);
    expect(newJob.ticket_number).not.toBeNull();

    const { data: originalRow } = await admin.from("print_jobs").select("reprint_note").eq("id", jobId).single();
    expect(originalRow!.reprint_note).toBe("Reprinted pages 2 to 4 on test.");

    const { data: auditRows } = await admin.from("audit_log").select("action, target_id, details").eq("action", "job_reprinted").eq("target_id", jobId).limit(1);
    expect(auditRows?.[0]?.details).toMatchObject({ new_job_id: newJobId, copies: 2 });
  });

  it("set_original_job_refund_not_needed: a reprint job reaching 'printed' resolves the original's PENDING refund to 'not_needed'", async () => {
    const jobId = await createPaidJob({ status: "print_failed", refund_status: "pending", refund_requested_at: new Date().toISOString() });
    const reprintJobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("print_jobs").insert({
      id: reprintJobId, status: "printing", file_name: "reprint.pdf", selected_pages: [1, 2], settings: SETTINGS,
      total_price: 0, content_hash: "hash-reprint", provider: "razorpay", provider_order_id: "",
      pdf_storage_path: `${reprintJobId}.pdf`, kiosk_id: kioskId, payment_method: "reprint", original_job_id: jobId,
    });
    if (insertError) throw insertError;
    createdJobIds.push(reprintJobId);

    await admin.from("print_jobs").update({ status: "printed" }).eq("id", reprintJobId);

    const { data: originalRow } = await admin.from("print_jobs").select("refund_status").eq("id", jobId).single();
    expect(originalRow!.refund_status).toBe("not_needed");
  });

  it("set_original_job_refund_not_needed: never overwrites a refund that's already 'processing' — only a 'pending' one", async () => {
    const jobId = await createPaidJob({ status: "print_failed", refund_status: "processing" });
    const reprintJobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("print_jobs").insert({
      id: reprintJobId, status: "printing", file_name: "reprint.pdf", selected_pages: [1], settings: SETTINGS,
      total_price: 0, content_hash: "hash-reprint-2", provider: "razorpay", provider_order_id: "",
      pdf_storage_path: `${reprintJobId}.pdf`, kiosk_id: kioskId, payment_method: "reprint", original_job_id: jobId,
    });
    if (insertError) throw insertError;
    createdJobIds.push(reprintJobId);

    await admin.from("print_jobs").update({ status: "printed" }).eq("id", reprintJobId);

    const { data: originalRow } = await admin.from("print_jobs").select("refund_status").eq("id", jobId).single();
    expect(originalRow!.refund_status).toBe("processing");
  });

  it("a free reprint job that itself fails never gets a refund_status — payment_method = 'reprint' is excluded from set_print_job_refund_pending, same as 'staff'", async () => {
    const jobId = await createPaidJob({ status: "print_failed" });
    const reprintJobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("print_jobs").insert({
      id: reprintJobId, status: "printing", file_name: "reprint.pdf", selected_pages: [1], settings: SETTINGS,
      total_price: 0, content_hash: "hash-reprint-3", provider: "razorpay", provider_order_id: "",
      pdf_storage_path: `${reprintJobId}.pdf`, kiosk_id: kioskId, payment_method: "reprint", original_job_id: jobId,
    });
    if (insertError) throw insertError;
    createdJobIds.push(reprintJobId);

    await admin.from("print_jobs").update({ status: "print_failed", error: "jam" }).eq("id", reprintJobId);

    const { data: reprintRow } = await admin.from("print_jobs").select("refund_status").eq("id", reprintJobId).single();
    expect(reprintRow!.refund_status).toBeNull();
  });
});
