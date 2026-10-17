import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for the print_blocked state
 * (supabase/migrations/2026-10-17_print_blocked_state.sql) — the part pure
 * unit tests can't verify: that the new columns genuinely exist and
 * round-trip, that print_jobs_admin_view/kiosk_status_admin_view actually
 * surface them to a signed-in staff session (unmasked, unlike the
 * refund_* columns), and that cancel_job's extended guard genuinely
 * accepts 'print_blocked' now. The pure retry/classification logic itself
 * (recoverable vs unrecoverable, the generous time limit, the deadline
 * extension) is covered far more cheaply, with no database at all, in
 * lib/print/cups.test.ts and lib/print/ready-timing.test.ts — see those
 * files for "paper out during a job," "paper loaded later," and "the time
 * limit expiring." The 4th scenario this task's own tests ask for — "a job
 * that printed after being marked failed" — is covered in
 * lib/store.test.ts's failPrintingJob suite (the atomic status guard
 * itself is a plain `.in('status', [...])` filter, not a stored
 * procedure, so there's no additional SQL-side behavior to prove here
 * beyond "the column exists and the filter works," which this suite's own
 * cancel_job test already exercises via the identical mechanism).
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-17_print_blocked_state.sql to a
 *      DEV Supabase project — never production.
 *   2. Set these three env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *        STAFF_PRINT_TEST_SUPABASE_ANON_KEY=<anon/publishable key>
 *   3. Run: npx vitest run supabase/print-blocked-state.integration.test.ts
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
    "[print-blocked-state] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);
const SETTINGS = { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 };

describe.skipIf(!hasCredentials)("print_blocked state (real Supabase)", () => {
  let admin: SupabaseClient;
  let staffEmail: string;
  let staffUserId: string;
  const kioskId = `test_blocked_${Date.now()}`;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: kioskId });

    staffEmail = `blocked-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) await admin.from("print_jobs").delete().in("id", createdJobIds);
    await admin.from("kiosk_status").delete().eq("id", kioskId);
    if (staffUserId) await admin.auth.admin.deleteUser(staffUserId);
  });

  async function signInAs(email: string): Promise<SupabaseClient> {
    const client = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
    if (error) throw error;
    return client;
  }

  async function createPrintingJob(): Promise<string> {
    const jobId = crypto.randomUUID();
    const { error } = await admin.from("print_jobs").insert({
      id: jobId, status: "printing", file_name: "blocked-test.pdf", selected_pages: [1], settings: SETTINGS,
      total_price: 10, content_hash: `hash-${jobId}`, provider: "razorpay", provider_order_id: `order_${jobId}`,
      pdf_storage_path: `${jobId}.pdf`, kiosk_id: kioskId,
    });
    if (error) throw error;
    createdJobIds.push(jobId);
    return jobId;
  }

  it("print_jobs.blocked_reason exists and round-trips, surfaced unmasked to staff via print_jobs_admin_view", async () => {
    const jobId = await createPrintingJob();
    const { error: updateError } = await admin.from("print_jobs").update({ status: "print_blocked", blocked_reason: "media-empty" }).eq("id", jobId);
    if (updateError) throw updateError;

    const staff = await signInAs(staffEmail);
    const { data, error } = await staff.from("print_jobs_admin_view").select("status, blocked_reason").eq("id", jobId).single();
    expect(error).toBeNull();
    expect(data!.status).toBe("print_blocked");
    // Unmasked — unlike the refund_* columns, this is never null for staff.
    expect(data!.blocked_reason).toBe("media-empty");
  });

  it("kiosk_status.print_blocked_reason / print_blocked_at exist and round-trip, surfaced unmasked to staff via kiosk_status_admin_view", async () => {
    const blockedAt = new Date().toISOString();
    const { error: updateError } = await admin.from("kiosk_status").update({ print_blocked_reason: "offline", print_blocked_at: blockedAt }).eq("id", kioskId);
    if (updateError) throw updateError;

    const staff = await signInAs(staffEmail);
    const { data, error } = await staff.from("kiosk_status_admin_view").select("print_blocked_reason, print_blocked_at").eq("id", kioskId).single();
    expect(error).toBeNull();
    expect(data!.print_blocked_reason).toBe("offline");
    expect(data!.print_blocked_at).not.toBeNull();

    // Clears cleanly back to null (clearKioskPrintBlocked's own shape).
    await admin.from("kiosk_status").update({ print_blocked_reason: null, print_blocked_at: null }).eq("id", kioskId);
    const { data: cleared } = await admin.from("kiosk_status_admin_view").select("print_blocked_reason").eq("id", kioskId).single();
    expect(cleared!.print_blocked_reason).toBeNull();
  });

  it("cancel_job now accepts a print_blocked job (extended guard), logging the audit entry same as any other cancellation", async () => {
    const jobId = await createPrintingJob();
    await admin.from("print_jobs").update({ status: "print_blocked", blocked_reason: "door-open" }).eq("id", jobId);

    const staff = await signInAs(staffEmail);
    const { error } = await staff.rpc("cancel_job", { p_job_id: jobId });
    expect(error).toBeNull();

    const { data: row } = await admin.from("print_jobs").select("status").eq("id", jobId).single();
    expect(row!.status).toBe("cancelled");

    const { data: auditRows } = await admin.from("audit_log").select("action, details").eq("target_id", jobId).eq("action", "job_cancelled").limit(1);
    expect(auditRows?.[0]?.details).toMatchObject({ before: { status: "print_blocked" }, after: { status: "cancelled" } });
  });

  it("cancel_job still refuses a job that's already printed — the pre-existing guard is untouched by the print_blocked extension", async () => {
    const jobId = await createPrintingJob();
    await admin.from("print_jobs").update({ status: "printed" }).eq("id", jobId);

    const staff = await signInAs(staffEmail);
    const { error } = await staff.rpc("cancel_job", { p_job_id: jobId });
    expect(error).toBeNull(); // the RPC itself never errors — it just updates zero rows

    const { data: row } = await admin.from("print_jobs").select("status").eq("id", jobId).single();
    expect(row!.status).toBe("printed");
  });
});
