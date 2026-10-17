import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for the refund approval
 * workflow — print-agent/index.ts no longer refunds a failed job
 * automatically; a job lands in refund_status = 'pending' instead (via the
 * set_print_job_refund_pending trigger) and an owner approves it from the
 * admin Refunds page (lib/refund.ts's attemptRefund, which calls
 * claim_refund_for_processing / complete_refund / fail_refund). The atomic
 * claim (double-click/two-tabs safety), the reprint-since-failing race,
 * and the owner/staff masking can only be genuinely proven against a real
 * PostgREST + Postgres instance, not a mock — same reasoning as every
 * other *.integration.test.ts file in this directory.
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-16_refund_approval_workflow.sql
 *      to a DEV Supabase project — never production.
 *   2. Set these three env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *        STAFF_PRINT_TEST_SUPABASE_ANON_KEY=<anon/publishable key>
 *   3. Run: npx vitest run supabase/refund-approval.integration.test.ts
 *
 * This suite never calls a real payment gateway — claim_refund_for_processing
 * / complete_refund / fail_refund are exactly the three RPCs lib/refund.ts
 * itself calls around its own (here, skipped) gateway call, so testing them
 * directly covers the real atomicity/race-safety guarantees without needing
 * a sandbox Razorpay/Cashfree account.
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
    "[refund-approval] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);
const SETTINGS = { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 };

interface PrintJobRow {
  id: string;
  status: string;
  refund_status: string | null;
  refunded_at: string | null;
}

describe.skipIf(!hasCredentials)("refund approval workflow (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerEmail: string;
  let staffEmail: string;
  let ownerUserId: string;
  let staffUserId: string;
  const kioskId = `test_refunds_${Date.now()}`;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: kioskId });

    ownerEmail = `refund-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `refund-staff-${Date.now()}@example.invalid`;
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

  /** Inserts a job already 'paid', then updates it to 'print_failed' via a SEPARATE statement — the trigger only fires on an UPDATE where old.status is distinct from 'print_failed', so a direct INSERT-as-print_failed would never exercise it, same as a real job's own lifecycle never does. */
  async function createPrintFailedJob(overrides: { totalPrice?: number } = {}): Promise<string> {
    const jobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("print_jobs").insert({
      id: jobId, status: "paid", file_name: "refund-test.pdf", selected_pages: [1], settings: SETTINGS,
      total_price: overrides.totalPrice ?? 10, content_hash: `hash-${jobId}`, provider: "razorpay",
      provider_order_id: `order_${jobId}`, provider_meta: { paymentRef: `pay_${jobId}` },
      pdf_storage_path: `${jobId}.pdf`, kiosk_id: kioskId,
    });
    if (insertError) throw insertError;
    createdJobIds.push(jobId);

    const { error: failError } = await admin.from("print_jobs").update({ status: "print_failed", error: "test failure" }).eq("id", jobId);
    if (failError) throw failError;
    return jobId;
  }

  async function getJobRow(jobId: string): Promise<PrintJobRow> {
    const { data, error } = await admin.from("print_jobs").select("id, status, refund_status, refunded_at").eq("id", jobId).single();
    if (error) throw error;
    return data as PrintJobRow;
  }

  it("stamps refund_status = 'pending' automatically the instant a paid job becomes print_failed", async () => {
    const jobId = await createPrintFailedJob();
    const row = await getJobRow(jobId);
    expect(row.status).toBe("print_failed");
    expect(row.refund_status).toBe("pending");
  });

  it("never stamps refund_status for a free staff print that fails — there was never any money to refund", async () => {
    const jobId = crypto.randomUUID();
    const { error: insertError } = await admin.from("print_jobs").insert({
      id: jobId, status: "paid", file_name: "staff-fail-test.pdf", selected_pages: [1], settings: SETTINGS,
      total_price: 0, content_hash: `hash-${jobId}`, provider: "razorpay", provider_order_id: "",
      pdf_storage_path: `${jobId}.pdf`, kiosk_id: kioskId, payment_method: "staff", is_free: true, waived_amount: 10,
    });
    if (insertError) throw insertError;
    createdJobIds.push(jobId);

    await admin.from("print_jobs").update({ status: "print_failed", error: "test failure" }).eq("id", jobId);

    const row = await getJobRow(jobId);
    expect(row.refund_status).toBeNull();
  });

  it("a double click / two open tabs: two concurrent claims on the same job — exactly one succeeds, the other is refused with a clear reason", async () => {
    const jobId = await createPrintFailedJob();
    const owner = await signInAs(ownerEmail);

    const [first, second] = await Promise.all([
      owner.rpc("claim_refund_for_processing", { p_job_id: jobId }),
      owner.rpc("claim_refund_for_processing", { p_job_id: jobId }),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error!.message).toMatch(/already being processed/i);

    const row = await getJobRow(jobId);
    expect(row.status).toBe("print_failed");
    // Still 'processing' — this test only exercises the claim itself, never
    // calls complete_refund/fail_refund (no real gateway call), same as
    // the "never calls a real payment gateway" note in this file's own
    // top comment.
    expect(row.refund_status).toBe("processing");
  });

  it("bulk with one failure: claiming three jobs in sequence succeeds for the two eligible ones and fails only the ineligible one, independently", async () => {
    const eligibleA = await createPrintFailedJob();
    const eligibleB = await createPrintFailedJob();
    const alreadyRefunded = await createPrintFailedJob();
    await admin.from("print_jobs").update({ refund_status: "refunded", refunded_at: new Date().toISOString() }).eq("id", alreadyRefunded);

    const owner = await signInAs(ownerEmail);
    const outcomes: { jobId: string; ok: boolean; error?: string }[] = [];
    for (const jobId of [eligibleA, alreadyRefunded, eligibleB]) {
      const { error } = await owner.rpc("claim_refund_for_processing", { p_job_id: jobId });
      outcomes.push({ jobId, ok: !error, error: error?.message });
    }

    expect(outcomes.filter((o) => o.ok).map((o) => o.jobId).sort()).toEqual([eligibleA, eligibleB].sort());
    const failedOutcome = outcomes.find((o) => o.jobId === alreadyRefunded);
    expect(failedOutcome?.ok).toBe(false);
    expect(failedOutcome?.error).toMatch(/already been refunded/i);
    // The one failure never blocked or rolled back the other two — each
    // claim is its own independent statement/request, exactly as
    // app/api/admin/refund's own per-job loop relies on.
    expect((await getJobRow(eligibleA)).refund_status).toBe("processing");
    expect((await getJobRow(eligibleB)).refund_status).toBe("processing");
  });

  it("job printed after failing: a reprint that resets refund_status makes a later claim attempt fail with a specific, accurate reason", async () => {
    const jobId = await createPrintFailedJob();
    const owner = await signInAs(ownerEmail);

    // force_reprint_job resets refund_status to null as part of the same
    // atomic update — see supabase/schema.sql's own comment on why.
    const { error: reprintError } = await owner.rpc("force_reprint_job", { p_job_id: jobId });
    if (reprintError) throw reprintError;

    const afterReprint = await getJobRow(jobId);
    expect(afterReprint.status).toBe("paid");
    expect(afterReprint.refund_status).toBeNull();

    // Simulates the print agent actually finishing it this time.
    await admin.from("print_jobs").update({ status: "printed" }).eq("id", jobId);

    const { error: claimError } = await owner.rpc("claim_refund_for_processing", { p_job_id: jobId });
    expect(claimError).not.toBeNull();
    expect(claimError!.message).toMatch(/no longer print_failed/i);
    expect(claimError!.message).toMatch(/printed/i);
  });

  it("refuses a reprint while a refund is actively being processed — closes the race that could otherwise refund AND reprint the same job", async () => {
    const jobId = await createPrintFailedJob();
    const owner = await signInAs(ownerEmail);

    const { error: claimError } = await owner.rpc("claim_refund_for_processing", { p_job_id: jobId });
    if (claimError) throw claimError;
    expect((await getJobRow(jobId)).refund_status).toBe("processing");

    const { error: reprintError } = await owner.rpc("force_reprint_job", { p_job_id: jobId });
    // No error is raised (force_reprint_job has no role-based "refuse"
    // path for this, only its own WHERE guard silently matching zero
    // rows) — the row simply must not have changed.
    expect(reprintError).toBeNull();
    const row = await getJobRow(jobId);
    expect(row.status).toBe("print_failed");
    expect(row.refund_status).toBe("processing");
  });

  it("staff access blocked: print_jobs_admin_view masks every refund_* column to null for a staff session", async () => {
    const jobId = await createPrintFailedJob();
    const staff = await signInAs(staffEmail);

    const { data, error } = await staff.from("print_jobs_admin_view").select("*").eq("id", jobId).single();
    expect(error).toBeNull();
    expect(data!.refund_status).toBeNull();
    expect(data!.refund_requested_at).toBeNull();
    expect(data!.refunded_by).toBeNull();
    expect(data!.refund_provider_id).toBeNull();
    expect(data!.refund_error).toBeNull();
    // The underlying row genuinely has a value — proves this is real
    // masking, not just a coincidentally-empty field.
    const real = await getJobRow(jobId);
    expect(real.refund_status).toBe("pending");
  });

  it("staff access blocked: a staff session cannot call any of the four refund RPCs at all — no grant to authenticated, only service_role", async () => {
    const jobId = await createPrintFailedJob();
    const staff = await signInAs(staffEmail);

    const claim = await staff.rpc("claim_refund_for_processing", { p_job_id: jobId });
    expect(claim.error).not.toBeNull();

    const complete = await staff.rpc("complete_refund", { p_job_id: jobId, p_refund_id: "rfnd_fake" });
    expect(complete.error).not.toBeNull();

    const fail = await staff.rpc("fail_refund", { p_job_id: jobId, p_error: "fake" });
    expect(fail.error).not.toBeNull();

    const bulk = await staff.rpc("record_refund_bulk_action", { p_job_ids: [jobId], p_total: 10, p_succeeded: 1, p_failed: 0 });
    expect(bulk.error).not.toBeNull();
  });

  it("an anonymous (signed-out) caller cannot call claim_refund_for_processing either", async () => {
    const jobId = await createPrintFailedJob();
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("claim_refund_for_processing", { p_job_id: jobId });
    expect(error).not.toBeNull();
  });
});
