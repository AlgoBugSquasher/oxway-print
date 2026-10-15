import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for
 * get_kiosk_period_breakdown() — the Overview dashboard's period totals
 * (Problem 1). Bucket boundaries, the queue_time-vs-ready_at split, and
 * owner/staff masking can only be genuinely proven against a real
 * PostgREST + Postgres instance, not a mock — same reasoning as the other
 * *.integration.test.ts files in this directory, which this mirrors (down
 * to the env var names — all of them point at the same "dev Supabase
 * project," so one setup covers every one of them).
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-14_overview_dashboard_and_refills.sql
 *      to a DEV Supabase project — never production.
 *   2. Set these three env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *        STAFF_PRINT_TEST_SUPABASE_ANON_KEY=<anon/publishable key>
 *   3. Run: npx vitest run supabase/overview-dashboard.integration.test.ts
 *
 * Every row/user this suite creates is scoped to its own randomly-
 * generated id, cleaned up in afterAll. Still: dev project only.
 *
 * Known limitation of the midnight-boundary test below: it inserts one row
 * dated "yesterday 23:59 IST" and reads it back via period "month" — this
 * is correct every day of the month except the 1st (where "yesterday"
 * falls in the previous month's bucket window and the test would need a
 * real clock to actually cross that boundary). Accepted the same way this
 * codebase already accepts e.g. DAILY_CAP tests assuming a fresh usage_date.
 */

const SUPABASE_URL = process.env.STAFF_PRINT_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_ANON_KEY;
const hasCredentials = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!hasCredentials) {
  console.warn(
    "[overview-dashboard] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_KIOSK_ID = `test_overview_${Date.now()}`;
const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);
const SETTINGS = { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 };

interface PeriodRow {
  bucket_start: string;
  revenue: number | null;
  refund_amount: number | null;
  refund_count: number | null;
  pages_printed: number;
  prints_completed: number;
  free_print_count: number;
  free_print_pages: number;
  free_print_waived_amount: number | null;
}

describe.skipIf(!hasCredentials)("get_kiosk_period_breakdown (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerEmail: string;
  let staffEmail: string;
  let ownerUserId: string;
  let staffUserId: string;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: TEST_KIOSK_ID });

    ownerEmail = `overview-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `overview-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) await admin.from("print_jobs").delete().in("id", createdJobIds);
    await admin.from("kiosk_status").delete().eq("id", TEST_KIOSK_ID);
    if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId);
    if (staffUserId) await admin.auth.admin.deleteUser(staffUserId);
  });

  async function signInAs(email: string): Promise<SupabaseClient> {
    const client = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
    if (error) throw error;
    return client;
  }

  /** Inserts a print_jobs row with every timestamp under direct control — the only way to deterministically test bucket boundaries without controlling the system clock. Explicit non-null queue_time bypasses set_print_job_queue_time's trigger (it only stamps when queue_time IS NULL — see supabase/schema.sql §6d). */
  async function insertJob(overrides: {
    queueTime: string | null;
    readyAt: string | null;
    updatedAt: string;
    totalPrice: number;
    refundedAt?: string | null;
    isFree?: boolean;
    waivedAmount?: number | null;
    pages?: number;
  }) {
    const jobId = crypto.randomUUID();
    const pages = overrides.pages ?? 1;
    const { error } = await admin.from("print_jobs").insert({
      id: jobId,
      status: "printed",
      file_name: "overview-test.pdf",
      selected_pages: Array.from({ length: pages }, (_, i) => i + 1),
      settings: SETTINGS,
      total_price: overrides.totalPrice,
      content_hash: `hash-${jobId}`,
      provider: "razorpay",
      pdf_storage_path: `${jobId}.pdf`,
      kiosk_id: TEST_KIOSK_ID,
      queue_time: overrides.queueTime,
      ready_at: overrides.readyAt,
      updated_at: overrides.updatedAt,
      refunded_at: overrides.refundedAt ?? null,
      is_free: overrides.isFree ?? false,
      waived_amount: overrides.waivedAmount ?? null,
    });
    if (error) throw error;
    createdJobIds.push(jobId);
    return jobId;
  }

  /** Most recent Asia/Kolkata midnight, as a real UTC Date — Kolkata is a fixed UTC+5:30 offset (no DST), so this is exact. */
  function mostRecentKolkataMidnightUtc(): Date {
    const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // shift to IST wall-clock
    const istMidnight = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), 0, 0, 0));
    return new Date(istMidnight.getTime() - 5.5 * 60 * 60 * 1000); // shift back to real UTC instant
  }

  it("buckets a job's revenue by queue_time and its pages by ready_at — a job paid just before midnight IST and printed just after lands in two different day buckets for the two different metrics", async () => {
    const todayMidnightUtc = mostRecentKolkataMidnightUtc();
    const paidJustBeforeMidnight = new Date(todayMidnightUtc.getTime() - 60_000).toISOString(); // 23:59 IST yesterday
    const printedJustAfterMidnight = new Date(todayMidnightUtc.getTime() + 60_000).toISOString(); // 00:01 IST today

    await insertJob({ queueTime: paidJustBeforeMidnight, readyAt: printedJustAfterMidnight, updatedAt: printedJustAfterMidnight, totalPrice: 7, pages: 3 });

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "month", p_kiosk_id: TEST_KIOSK_ID });
    if (error) throw error;
    const rows = data as PeriodRow[];

    const yesterdayDateKey = new Date(paidJustBeforeMidnight).toISOString().slice(0, 10);
    const todayDateKey = new Date(printedJustAfterMidnight).toISOString().slice(0, 10);

    const revenueBucket = rows.find((row) => row.bucket_start.slice(0, 10) === yesterdayDateKey);
    const pagesBucket = rows.find((row) => row.bucket_start.slice(0, 10) === todayDateKey);

    expect(revenueBucket?.revenue).toBeGreaterThanOrEqual(7);
    expect(pagesBucket?.pages_printed).toBeGreaterThanOrEqual(3);
    // The revenue bucket's OWN pages_printed must not also carry these 3
    // pages — they belong to the completion (ready_at) bucket, not the
    // payment (queue_time) bucket, confirming the two timestamps are
    // genuinely tracked independently rather than one masking the other.
    if (revenueBucket && revenueBucket !== pagesBucket) {
      expect(revenueBucket.pages_printed).toBe(0);
    }
  });

  it("nets revenue against a refund within the same bucket, while still reporting the refund amount and count separately", async () => {
    const now = new Date().toISOString();
    await insertJob({ queueTime: now, readyAt: now, updatedAt: now, totalPrice: 15, refundedAt: now });

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "today", p_kiosk_id: TEST_KIOSK_ID });
    if (error) throw error;
    const rows = data as PeriodRow[];

    const totalRevenue = rows.reduce((sum, row) => sum + (row.revenue ?? 0), 0);
    const totalRefundAmount = rows.reduce((sum, row) => sum + (row.refund_amount ?? 0), 0);
    const totalRefundCount = rows.reduce((sum, row) => sum + (row.refund_count ?? 0), 0);

    expect(totalRevenue).toBe(0); // the refunded job contributes nothing to net revenue
    expect(totalRefundAmount).toBeGreaterThanOrEqual(15);
    expect(totalRefundCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps a free staff job out of revenue entirely, counting it only under free_print_* — pages/count included, waived value separate from real revenue", async () => {
    const now = new Date().toISOString();
    await insertJob({ queueTime: now, readyAt: now, updatedAt: now, totalPrice: 0, isFree: true, waivedAmount: 12, pages: 4 });

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "today", p_kiosk_id: TEST_KIOSK_ID });
    if (error) throw error;
    const rows = data as PeriodRow[];

    const totalFreeCount = rows.reduce((sum, row) => sum + row.free_print_count, 0);
    const totalFreePages = rows.reduce((sum, row) => sum + row.free_print_pages, 0);
    const totalFreeWaived = rows.reduce((sum, row) => sum + (row.free_print_waived_amount ?? 0), 0);
    const totalPrintsCompleted = rows.reduce((sum, row) => sum + row.prints_completed, 0);

    expect(totalFreeCount).toBeGreaterThanOrEqual(1);
    expect(totalFreePages).toBeGreaterThanOrEqual(4);
    expect(totalFreeWaived).toBeGreaterThanOrEqual(12);
    // prints_completed is the PAID-print counter — a free print must not
    // also inflate it (that's exactly what free_print_count is for).
    expect(totalPrintsCompleted).toBe(0);
  });

  it("masks every money field to null for staff while still returning the real pages/prints numbers — owners see money, staff see pages and prints only", async () => {
    const now = new Date().toISOString();
    await insertJob({ queueTime: now, readyAt: now, updatedAt: now, totalPrice: 9, pages: 2 });

    const staff = await signInAs(staffEmail);
    const { data, error } = await staff.rpc("get_kiosk_period_breakdown", { p_period: "today", p_kiosk_id: TEST_KIOSK_ID });
    if (error) throw error;
    const rows = data as PeriodRow[];

    expect(rows.every((row) => row.revenue === null)).toBe(true);
    expect(rows.every((row) => row.refund_amount === null)).toBe(true);
    expect(rows.every((row) => row.free_print_waived_amount === null)).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.pages_printed, 0)).toBeGreaterThanOrEqual(2);
  });

  it("zero-fills every bucket in the window, not just the ones with activity — an empty day reads as 0, never a missing row", async () => {
    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "week", p_kiosk_id: TEST_KIOSK_ID });
    if (error) throw error;
    const rows = data as PeriodRow[];

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.pages_printed).not.toBeNull();
      expect(row.prints_completed).not.toBeNull();
    }
  });
});
