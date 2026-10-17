import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for
 * supabase/migrations/2026-10-21_sales_stats.sql — the dense zero-filling,
 * masking, and rate math a pure unit test can't verify (lib/admin/
 * sales-stats.test.ts covers the pure client-side helpers — finding the
 * busiest/quietest entry in a list the RPC already returned — with no
 * database at all; this covers the RPCs themselves).
 *
 * SKIPPED BY DEFAULT — see supabase/restart-and-reprint.integration.test.ts
 * for the same three env vars and setup steps this suite reuses.
 *
 *   npx vitest run supabase/sales-stats.integration.test.ts
 */

const SUPABASE_URL = process.env.STAFF_PRINT_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_ANON_KEY;
const hasCredentials = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!hasCredentials) {
  console.warn(
    "[sales-stats] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);

describe.skipIf(!hasCredentials)("get_kiosk_hourly_pattern / weekday_pattern / daily_pattern / sales_summary (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerEmail: string;
  let staffEmail: string;
  let ownerUserId: string;
  let staffUserId: string;
  const kioskId = `test_sales_${Date.now()}`;
  const createdOrderIds: string[] = [];
  const createdFailureIds: string[] = [];
  const createdRefundEventIds: string[] = [];
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: kioskId });

    ownerEmail = `sales-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `sales-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) await admin.from("print_orders").delete().in("id", createdOrderIds);
    if (createdFailureIds.length > 0) await admin.from("print_failures").delete().in("id", createdFailureIds);
    if (createdRefundEventIds.length > 0) await admin.from("refund_events").delete().in("id", createdRefundEventIds);
    if (createdJobIds.length > 0) await admin.from("print_jobs").delete().in("id", createdJobIds);
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

  it("returns dense, all-zero rows for a kiosk with no activity yet", async () => {
    const owner = await signInAs(ownerEmail);

    const { data: hourly, error: hourlyError } = await owner.rpc("get_kiosk_hourly_pattern", { p_period: "today", p_kiosk_id: kioskId });
    expect(hourlyError).toBeNull();
    expect(hourly).toHaveLength(24);
    expect(hourly!.every((row: { job_count: number }) => row.job_count === 0)).toBe(true);

    const { data: weekday, error: weekdayError } = await owner.rpc("get_kiosk_weekday_pattern", { p_period: "today", p_kiosk_id: kioskId });
    expect(weekdayError).toBeNull();
    expect(weekday).toHaveLength(7);
    expect(weekday!.every((row: { job_count: number }) => row.job_count === 0)).toBe(true);

    const { data: summary, error: summaryError } = await owner.rpc("get_kiosk_sales_summary", { p_period: "today", p_kiosk_id: kioskId });
    expect(summaryError).toBeNull();
    expect(summary![0].color_jobs).toBe(0);
    expect(summary![0].bw_jobs).toBe(0);
    expect(summary![0].failure_rate).toBe(0);
    expect(summary![0].refund_rate).toBe(0);
  });

  it("surfaces a single job in exactly the right hour/weekday bucket and in the sales summary", async () => {
    const now = new Date();
    const { data: inserted, error: insertError } = await admin.from("print_orders").insert({
      kiosk_id: kioskId, pages_printed: 4, amount: 25, color_mode: true, created_at: now.toISOString(),
    }).select("id").single();
    if (insertError) throw insertError;
    createdOrderIds.push(inserted!.id);

    const owner = await signInAs(ownerEmail);
    const { data: hourly, error: hourlyError } = await owner.rpc("get_kiosk_hourly_pattern", { p_period: "today", p_kiosk_id: kioskId });
    expect(hourlyError).toBeNull();
    const nonZeroHours = hourly!.filter((row: { job_count: number }) => row.job_count > 0);
    expect(nonZeroHours).toHaveLength(1);
    expect(nonZeroHours[0].pages_printed).toBe(4);

    const { data: weekday, error: weekdayError } = await owner.rpc("get_kiosk_weekday_pattern", { p_period: "today", p_kiosk_id: kioskId });
    expect(weekdayError).toBeNull();
    const nonZeroWeekdays = weekday!.filter((row: { job_count: number }) => row.job_count > 0);
    expect(nonZeroWeekdays).toHaveLength(1);

    const { data: summary, error: summaryError } = await owner.rpc("get_kiosk_sales_summary", { p_period: "today", p_kiosk_id: kioskId });
    expect(summaryError).toBeNull();
    expect(summary![0].color_jobs).toBe(1);
    expect(summary![0].bw_jobs).toBe(0);
    expect(summary![0].avg_pages_per_job).toBe(4);
    expect(summary![0].avg_order_value).toBe(25);
  });

  it("masks avg_order_value for staff while counts/rates stay visible", async () => {
    const staff = await signInAs(staffEmail);
    const { data, error } = await staff.rpc("get_kiosk_sales_summary", { p_period: "today", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    expect(data![0].avg_order_value).toBeNull();
    expect(typeof data![0].color_jobs).toBe("number");
    expect(typeof data![0].failure_rate).toBe("number");
  });

  it("computes failure_rate and refund_rate from the durable print_failures/refund_events tables", async () => {
    const failedJobId = crypto.randomUUID();
    createdJobIds.push(failedJobId);
    const { data: failure, error: failureError } = await admin.from("print_failures").insert({ kiosk_id: kioskId, job_id: failedJobId }).select("id").single();
    if (failureError) throw failureError;
    createdFailureIds.push(failure!.id);

    const refundedJobId = crypto.randomUUID();
    createdJobIds.push(refundedJobId);
    const { data: refundEvent, error: refundError } = await admin.from("refund_events").insert({ kiosk_id: kioskId, job_id: refundedJobId, amount: 10 }).select("id").single();
    if (refundError) throw refundError;
    createdRefundEventIds.push(refundEvent!.id);

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_sales_summary", { p_period: "today", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    expect(data![0].failed_jobs).toBeGreaterThanOrEqual(1);
    expect(data![0].refunded_jobs).toBeGreaterThanOrEqual(1);
    expect(data![0].failure_rate).toBeGreaterThan(0);
    expect(data![0].refund_rate).toBeGreaterThan(0);
  });
});
