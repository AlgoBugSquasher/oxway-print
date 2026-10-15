import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL concurrency tests against a real Supabase project — requirement #17
 * explicitly asks for "real parallel requests against a test database where
 * possible." Every other test in this repo (lib/store.test.ts's RPC-shape
 * assertions included) runs fully mocked, which can verify the TypeScript
 * call sites are correct but can never actually prove the atomic SQL itself
 * (the INSERT...ON CONFLICT...RETURNING counters, the FOR UPDATE SKIP
 * LOCKED claim, the partial unique index) behaves correctly under genuine
 * concurrent load — only a real Postgres instance can do that.
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-14_staff_print.sql (this whole
 *      feature's migration) to a DEV Supabase project — never production.
 *   2. Set these two env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *   3. Run: npx vitest run supabase/staff-print-concurrency.integration.test.ts
 *
 * This suite creates and deletes its own temporary auth users, a temporary
 * kiosk_status row, and every print_jobs row it creates, in beforeAll/
 * afterAll — safe to run repeatedly, and safe against a project with other
 * real data (everything is scoped to its own randomly-generated kiosk id
 * and user ids). Still: dev project only, never run this against production.
 */

const SUPABASE_URL = process.env.STAFF_PRINT_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY;
const hasCredentials = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

if (!hasCredentials) {
  console.warn(
    "[staff-print-concurrency] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL and " +
    "STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY (a dev Supabase project with this " +
    "feature's migration already applied) to actually run these against a real database."
  );
}

const TEST_KIOSK_ID = `test_concurrency_${Date.now()}`;
const DAILY_CAP = 20; // small and deterministic, independent of lib/config.ts's real default

interface StaffPrintJobRow {
  id: string;
  ticket_number: number;
  queue_time: string | null;
  payment_method: string;
}

describe.skipIf(!hasCredentials)("staff-print concurrency (real Supabase)", () => {
  let supabase: SupabaseClient;
  let staffUserId: string;
  let secondStaffUserId: string;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

    await supabase.from("kiosk_status").upsert({ id: TEST_KIOSK_ID });

    const { data: userA, error: userAError } = await supabase.auth.admin.createUser({
      email: `staff-print-test-${Date.now()}@example.invalid`,
      email_confirm: true,
      app_metadata: { role: "staff" },
    });
    if (userAError || !userA.user) throw new Error(`Could not create test staff user: ${userAError?.message}`);
    staffUserId = userA.user.id;

    const { data: userB, error: userBError } = await supabase.auth.admin.createUser({
      email: `staff-print-test-2-${Date.now()}@example.invalid`,
      email_confirm: true,
      app_metadata: { role: "staff" },
    });
    if (userBError || !userB.user) throw new Error(`Could not create second test staff user: ${userBError?.message}`);
    secondStaffUserId = userB.user.id;
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) await supabase.from("print_jobs").delete().in("id", createdJobIds);
    await supabase.from("staff_daily_page_usage").delete().in("user_id", [staffUserId, secondStaffUserId]);
    await supabase.from("kiosk_status").delete().eq("id", TEST_KIOSK_ID);
    if (staffUserId) await supabase.auth.admin.deleteUser(staffUserId);
    if (secondStaffUserId) await supabase.auth.admin.deleteUser(secondStaffUserId);
  });

  async function createStaffJob(overrides: Partial<{ userId: string; pages: number; idempotencyKey: string | null; dailyCap: number }> = {}) {
    const jobId = crypto.randomUUID();
    const pages = overrides.pages ?? 1;
    const { data, error } = await supabase.rpc("create_staff_print_job", {
      p_job_id: jobId,
      p_file_name: "concurrency-test.pdf",
      p_selected_pages: Array.from({ length: pages }, (_, i) => i + 1),
      p_settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
      p_waived_amount: pages * 2,
      p_content_hash: `hash-${jobId}`,
      p_provider: "razorpay",
      p_pdf_storage_path: `${jobId}.pdf`,
      p_kiosk_id: TEST_KIOSK_ID,
      p_idempotency_key: overrides.idempotencyKey ?? null,
      p_created_by: overrides.userId ?? staffUserId,
      p_daily_cap: overrides.dailyCap ?? DAILY_CAP,
    });
    if (error) throw error;
    const row = (data as StaffPrintJobRow[])[0];
    createdJobIds.push(row.id);
    return row;
  }

  /** Simulates a paying customer's job reaching 'paid' via the exact same path claimJobAsPaid uses (a pending_payment row, then the atomic UPDATE) — real jobs go through create-order first; this is the minimum real schema interaction needed to exercise the SAME queue_time trigger a real customer job would. */
  async function createCustomerPaidJob() {
    const jobId = crypto.randomUUID();
    const { error: insertError } = await supabase.from("print_jobs").insert({
      id: jobId,
      status: "pending_payment",
      file_name: "customer-concurrency-test.pdf",
      selected_pages: [1],
      settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
      total_price: 2,
      content_hash: `hash-${jobId}`,
      provider: "razorpay",
      pdf_storage_path: `${jobId}.pdf`,
      kiosk_id: TEST_KIOSK_ID,
    });
    if (insertError) throw insertError;
    createdJobIds.push(jobId);

    const { data, error } = await supabase
      .from("print_jobs")
      .update({ status: "paid", provider_meta: {} })
      .eq("id", jobId)
      .eq("status", "pending_payment")
      .select("id, ticket_number, queue_time")
      .single();
    if (error) throw error;
    return data as StaffPrintJobRow;
  }

  it("gives N concurrent staff jobs and M concurrent customer jobs all unique ticket codes — the shared next_ticket_number() sequence never double-assigns under real concurrency", async () => {
    const [staffJobs, customerJobs] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => createStaffJob())),
      Promise.all(Array.from({ length: 5 }, () => createCustomerPaidJob())),
    ]);
    const allTicketNumbers = [...staffJobs, ...customerJobs].map((job) => job.ticket_number);
    expect(new Set(allTicketNumbers).size).toBe(allTicketNumbers.length);
  });

  it("stamps queue_time on both a staff job and a customer job from the same trigger, and claim_next_paid_job processes them in strict queue_time order regardless of type", async () => {
    // Customer job created (and paid) first, then a staff job a moment
    // later — claim order must follow THAT sequence, not job type.
    const customerJob = await createCustomerPaidJob();
    await new Promise((resolve) => setTimeout(resolve, 50)); // ensure a distinguishable queue_time gap
    const staffJob = await createStaffJob();

    expect(customerJob.queue_time).not.toBeNull();
    expect(staffJob.queue_time).not.toBeNull();
    expect(new Date(customerJob.queue_time!).getTime()).toBeLessThan(new Date(staffJob.queue_time!).getTime());

    const { data: firstClaim, error: firstError } = await supabase.rpc("claim_next_paid_job", { p_kiosk_id: TEST_KIOSK_ID });
    if (firstError) throw firstError;
    expect((firstClaim as StaffPrintJobRow[])[0]?.id).toBe(customerJob.id);

    const { data: secondClaim, error: secondError } = await supabase.rpc("claim_next_paid_job", { p_kiosk_id: TEST_KIOSK_ID });
    if (secondError) throw secondError;
    expect((secondClaim as StaffPrintJobRow[])[0]?.id).toBe(staffJob.id);
  });

  it("never double-claims under concurrent claim_next_paid_job calls — FOR UPDATE SKIP LOCKED actually works", async () => {
    const jobs = await Promise.all(Array.from({ length: 6 }, () => createStaffJob()));

    // Fire more concurrent claims than there are ready jobs — the extras
    // must come back empty, never a duplicate of an already-claimed row.
    const claimResults = await Promise.all(
      Array.from({ length: 10 }, () => supabase.rpc("claim_next_paid_job", { p_kiosk_id: TEST_KIOSK_ID }))
    );
    const claimedIds = claimResults
      .map((result) => (result.data as StaffPrintJobRow[] | null)?.[0]?.id)
      .filter((id): id is string => Boolean(id));

    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no id claimed twice
    expect(claimedIds.length).toBe(jobs.length); // every job claimed exactly once, nothing lost
  });

  it("a double-clicked/retried submission with the same idempotency key resolves to the SAME job, even fired truly concurrently — never a duplicate", async () => {
    const idempotencyKey = `concurrency-test-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => createStaffJob({ idempotencyKey })));
    const uniqueIds = new Set(results.map((job) => job.id));
    expect(uniqueIds.size).toBe(1);
  });

  it("enforces the daily cap exactly under concurrent submissions — never lets more pages through than the cap, never rejects fewer than it should", async () => {
    const cap = 10;
    const perJobPages = 3; // 4 jobs * 3 pages = 12 > cap of 10 — exactly 3 should succeed (9 pages), the 4th must be rejected
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => createStaffJob({ userId: secondStaffUserId, pages: perJobPages, dailyCap: cap }))
    );

    const succeeded = attempts.filter((result) => result.status === "fulfilled");
    const failed = attempts.filter((result) => result.status === "rejected");
    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(1);

    const { data: usage, error } = await supabase
      .from("staff_daily_page_usage")
      .select("pages_printed")
      .eq("user_id", secondStaffUserId)
      .eq("usage_date", new Date().toISOString().slice(0, 10))
      .single();
    if (error) throw error;
    // The counter reflects only the SUCCESSFUL jobs' pages — the rejected
    // 4th attempt's own increment was rolled back with the rest of its
    // transaction (create_staff_print_job's own RAISE EXCEPTION), never
    // left as a partial charge against the rest of today's allowance.
    expect(usage.pages_printed).toBe(9);
  });
});
