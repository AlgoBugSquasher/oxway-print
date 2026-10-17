import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for
 * supabase/migrations/2026-10-20_revenue_durable_ledger.sql — specifically
 * the calendar-boundary and cross-period-refund behavior of
 * get_kiosk_period_breakdown()/get_pending_refund_summary() that a pure
 * unit test can't verify (date_trunc/generate_series run inside Postgres
 * itself, not lib/admin/period-stats.ts, which only sums rows it's handed —
 * see that file's own test for everything it covers instead).
 *
 * SKIPPED BY DEFAULT — see supabase/restart-and-reprint.integration.test.ts
 * for the same three env vars and setup steps this suite reuses
 * (STAFF_PRINT_TEST_SUPABASE_URL / _SERVICE_ROLE_KEY / _ANON_KEY, pointed at
 * a DEV project with this migration already applied).
 *
 *   npx vitest run supabase/revenue-period-breakdown.integration.test.ts
 */

const SUPABASE_URL = process.env.STAFF_PRINT_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_ANON_KEY;
const hasCredentials = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

if (!hasCredentials) {
  console.warn(
    "[revenue-period-breakdown] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);

/** Builds a timestamptz literal for a specific Kolkata wall-clock moment — Asia/Kolkata is a fixed +05:30 offset with no DST, so this is exact, not an approximation. */
function istIso(year: number, month: number, day: number, hour: number, minute: number, second: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+05:30`;
}

/** Today's own Kolkata-local calendar date, read off the real clock the test is running on — every boundary test below is built relative to this, so it stays correct regardless of what day it's actually run. */
function todayInKolkata(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date())
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {} as Record<string, string>);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

describe.skipIf(!hasCredentials)("get_kiosk_period_breakdown / get_pending_refund_summary (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerEmail: string;
  let staffEmail: string;
  let ownerUserId: string;
  let staffUserId: string;
  const kioskId = `test_revenue_${Date.now()}`;
  const createdOrderIds: string[] = [];
  const createdRefundEventIds: string[] = [];
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: kioskId });

    ownerEmail = `revenue-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `revenue-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) await admin.from("print_orders").delete().in("id", createdOrderIds);
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

  async function insertOrder(createdAtIso: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await admin.from("print_orders").insert({
      pages_printed: 1, amount: 100, color_mode: false, kiosk_id: kioskId, created_at: createdAtIso,
      ...overrides,
    }).select("id").single();
    if (error) throw error;
    createdOrderIds.push(data!.id);
    return data!.id;
  }

  async function insertRefundEvent(resolvedAtIso: string, amount: number): Promise<string> {
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { data, error } = await admin.from("refund_events").insert({
      kiosk_id: kioskId, job_id: jobId, amount, resolved_at: resolvedAtIso,
    }).select("id").single();
    if (error) throw error;
    createdRefundEventIds.push(data!.id);
    return data!.id;
  }

  it("excludes a print just before midnight IST from 'today' and includes one just after", async () => {
    const { year, month, day } = todayInKolkata();
    const yesterday = new Date(year, month - 1, day - 1);
    await insertOrder(istIso(yesterday.getFullYear(), yesterday.getMonth() + 1, yesterday.getDate(), 23, 59, 59), { amount: 111 });
    await insertOrder(istIso(year, month, day, 0, 0, 1), { amount: 222 });

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "today", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    const totalRevenue = data!.reduce((sum: number, row: { revenue: number }) => sum + row.revenue, 0);
    expect(totalRevenue).toBe(222);
  });

  it("excludes a print on the last day of last month from 'month' and includes one on the first of this month", async () => {
    const { year, month } = todayInKolkata();
    const lastMonth = new Date(year, month - 2, 1);
    const lastDayOfLastMonth = new Date(year, month - 1, 0).getDate();
    await insertOrder(istIso(lastMonth.getFullYear(), lastMonth.getMonth() + 1, lastDayOfLastMonth, 23, 59, 59), { amount: 333 });
    await insertOrder(istIso(year, month, 1, 0, 0, 1), { amount: 444 });

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "month", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    const totalRevenue = data!.reduce((sum: number, row: { revenue: number }) => sum + row.revenue, 0);
    expect(totalRevenue).toBe(444);
  });

  it("excludes a print on 31 Dec of last year from 'year' and includes one on 1 Jan of this year", async () => {
    const { year } = todayInKolkata();
    await insertOrder(istIso(year - 1, 12, 31, 23, 59, 59), { amount: 555 });
    await insertOrder(istIso(year, 1, 1, 0, 0, 1), { amount: 666 });

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "year", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    const totalRevenue = data!.reduce((sum: number, row: { revenue: number }) => sum + row.revenue, 0);
    expect(totalRevenue).toBe(666);
  });

  it("deducts a refund in the period it actually resolved, not the period of the original payment", async () => {
    const { year, month, day } = todayInKolkata();
    const lastMonth = new Date(year, month - 2, 15);
    // Paid last month — outside this month's print_orders window, so it
    // contributes nothing to this month's own revenue sum.
    await insertOrder(istIso(lastMonth.getFullYear(), lastMonth.getMonth() + 1, lastMonth.getDate(), 10, 0, 0), { amount: 777 });
    // Refund resolved THIS month.
    await insertRefundEvent(istIso(year, month, day, 9, 0, 0), 777);

    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("get_kiosk_period_breakdown", { p_period: "month", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    const totals = data!.reduce(
      (acc: { revenue: number; refund: number }, row: { revenue: number; refund_amount: number }) => ({
        revenue: acc.revenue + row.revenue,
        refund: acc.refund + row.refund_amount,
      }),
      { revenue: 0, refund: 0 },
    );
    expect(totals.refund).toBe(777);
    expect(totals.revenue).toBe(-777); // No revenue of its own this month, just the deduction.
  });

  it("masks revenue/refund_amount/waived_amount to null for staff, while pages_printed stays visible", async () => {
    await insertOrder(new Date().toISOString(), { amount: 50, pages_printed: 3 });

    const staff = await signInAs(staffEmail);
    const { data, error } = await staff.rpc("get_kiosk_period_breakdown", { p_period: "today", p_kiosk_id: kioskId });
    expect(error).toBeNull();
    for (const row of data!) {
      expect(row.revenue).toBeNull();
      expect(row.refund_amount).toBeNull();
      expect(row.free_print_waived_amount).toBeNull();
    }
    const totalPages = data!.reduce((sum: number, row: { pages_printed: number }) => sum + row.pages_printed, 0);
    expect(totalPages).toBeGreaterThanOrEqual(3);
  });

  it("get_pending_refund_summary reports a pending refund for the owner and masks it for staff", async () => {
    const jobId = crypto.randomUUID();
    createdJobIds.push(jobId);
    const { error: insertError } = await admin.from("print_jobs").insert({
      id: jobId, status: "print_failed", file_name: "pending-refund-test.pdf", selected_pages: [1],
      settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
      total_price: 20, content_hash: `hash-${jobId}`, provider: "razorpay", provider_order_id: `order_${jobId}`,
      pdf_storage_path: `${jobId}.pdf`, kiosk_id: kioskId, refund_status: "pending",
    });
    if (insertError) throw insertError;

    const owner = await signInAs(ownerEmail);
    const { data: ownerData, error: ownerError } = await owner.rpc("get_pending_refund_summary", { p_kiosk_id: kioskId });
    expect(ownerError).toBeNull();
    expect(ownerData![0].pending_refund_amount).toBeGreaterThanOrEqual(20);
    expect(ownerData![0].pending_refund_count).toBeGreaterThanOrEqual(1);

    const staff = await signInAs(staffEmail);
    const { data: staffData, error: staffError } = await staff.rpc("get_pending_refund_summary", { p_kiosk_id: kioskId });
    expect(staffError).toBeNull();
    expect(staffData![0].pending_refund_amount).toBeNull();
    expect(staffData![0].pending_refund_count).toBeNull();
  });
});
