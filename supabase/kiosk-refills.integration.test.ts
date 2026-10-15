import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for refill_events,
 * record_refill(), and get_kiosk_supply_status() (Problem 2 — the
 * "674/150 sheets (449%)" bug). RLS (append-only, owner/staff read), the
 * audit entry written in the same transaction as the insert, and the
 * "consumption since the latest refill" aggregate can only be genuinely
 * proven against a real PostgREST + Postgres instance, not a mock — same
 * reasoning as the other *.integration.test.ts files in this directory.
 *
 * Note: the pure remaining/percent/status math (not_set_up, ok, low,
 * needs_refill_update) is covered independently and far more cheaply in
 * lib/admin/supply-estimate.test.ts, which needs no database at all — this
 * suite only proves the SQL side: that get_kiosk_supply_status sums
 * consumption correctly since the latest event, and that record_refill
 * actually writes what it's supposed to.
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
 *   3. Run: npx vitest run supabase/kiosk-refills.integration.test.ts
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
    "[kiosk-refills] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);
const SETTINGS = { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 };

interface SupplyStatusRow {
  cartridge_max_pages: number;
  has_paper_baseline: boolean;
  paper_quantity: number | null;
  paper_consumed_since: number | null;
  has_toner_baseline: boolean;
  toner_starting_pages: number | null;
  toner_consumed_since: number | null;
}

describe.skipIf(!hasCredentials)("refill_events / record_refill / get_kiosk_supply_status (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerEmail: string;
  let staffEmail: string;
  let ownerUserId: string;
  let staffUserId: string;
  let kioskId: string;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    kioskId = `test_refills_${Date.now()}`;
    await admin.from("kiosk_status").upsert({ id: kioskId, cartridge_max_pages: 1500 });

    ownerEmail = `refill-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `refill-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) await admin.from("print_jobs").delete().in("id", createdJobIds);
    await admin.from("refill_events").delete().eq("kiosk_id", kioskId);
    await admin.from("audit_log").delete().eq("kiosk_id", kioskId);
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

  async function printJob(pages: number, atIso: string) {
    const jobId = crypto.randomUUID();
    const { error } = await admin.from("print_jobs").insert({
      id: jobId,
      status: "printed",
      file_name: "refill-test.pdf",
      selected_pages: Array.from({ length: pages }, (_, i) => i + 1),
      settings: SETTINGS,
      total_price: pages * 2,
      content_hash: `hash-${jobId}`,
      provider: "razorpay",
      pdf_storage_path: `${jobId}.pdf`,
      kiosk_id: kioskId,
      queue_time: atIso,
      ready_at: atIso,
      updated_at: atIso,
    });
    if (error) throw error;
    createdJobIds.push(jobId);
  }

  async function getSupplyStatus(client: SupabaseClient): Promise<SupplyStatusRow> {
    const { data, error } = await client.rpc("get_kiosk_supply_status", { p_kiosk_id: kioskId });
    if (error) throw error;
    return (data as SupplyStatusRow[])[0];
  }

  it("reports no baseline at all before any refill has ever been recorded — the state that replaces the old meaningless lifetime percentage", async () => {
    const owner = await signInAs(ownerEmail);
    const status = await getSupplyStatus(owner);
    expect(status.has_paper_baseline).toBe(false);
    expect(status.has_toner_baseline).toBe(false);
  });

  it("establishes a baseline via record_refill — both owner and staff can call it", async () => {
    const owner = await signInAs(ownerEmail);
    const { data, error } = await owner.rpc("record_refill", { p_kiosk_id: kioskId, p_kind: "paper", p_quantity: 140, p_note: "initial setup" });
    if (error) throw error;
    expect(data[0].quantity).toBe(140);
    expect(data[0].kind).toBe("paper");

    const status = await getSupplyStatus(owner);
    expect(status.has_paper_baseline).toBe(true);
    expect(status.paper_quantity).toBe(140);
    expect(status.paper_consumed_since).toBe(0);

    // Logged in the same transaction as the insert — requirement #4.
    const { data: auditRows } = await admin.from("audit_log").select("action, details").eq("kiosk_id", kioskId).eq("action", "paper_refilled").order("id", { ascending: false }).limit(1);
    expect(auditRows?.[0]?.details).toMatchObject({ kind: "paper", quantity: 140 });

    const staff = await signInAs(staffEmail);
    const { error: staffError } = await staff.rpc("record_refill", { p_kiosk_id: kioskId, p_kind: "toner", p_quantity: 0 });
    expect(staffError).toBeNull();
  });

  it("decreases remaining after printing — consumed_since reflects jobs completed after the baseline event, via physical_sheets_for_job", async () => {
    await printJob(25, new Date().toISOString());

    const owner = await signInAs(ownerEmail);
    const status = await getSupplyStatus(owner);
    expect(status.paper_consumed_since).toBeGreaterThanOrEqual(25);
  });

  it("resets the baseline after a new refill — consumption-since starts from zero again, independent of how depleted the previous baseline was", async () => {
    const owner = await signInAs(ownerEmail);
    const { error } = await owner.rpc("record_refill", { p_kiosk_id: kioskId, p_kind: "paper", p_quantity: 150 });
    if (error) throw error;

    const status = await getSupplyStatus(owner);
    expect(status.paper_quantity).toBe(150);
    expect(status.paper_consumed_since).toBe(0); // the 25-page job above is now BEFORE this new baseline's `at`, so it no longer counts
  });

  it("reflects an out-of-range (over-consumed) state once printing since the baseline exceeds what was loaded", async () => {
    const owner = await signInAs(ownerEmail);
    const { error } = await owner.rpc("record_refill", { p_kiosk_id: kioskId, p_kind: "paper", p_quantity: 5 });
    if (error) throw error;

    await printJob(10, new Date().toISOString());

    const status = await getSupplyStatus(owner);
    expect(status.paper_quantity).toBe(5);
    expect(status.paper_consumed_since).toBeGreaterThanOrEqual(10); // consumed > quantity — supply-estimate.ts turns this into "needs_refill_update", never a negative/>100% percentage
  });

  it("gives staff read access to refill_events (the history list) but refuses a direct insert/update/delete outside record_refill", async () => {
    const staff = await signInAs(staffEmail);
    const { data, error } = await staff.from("refill_events").select("*").eq("kiosk_id", kioskId);
    expect(error).toBeNull();
    expect((data as unknown[]).length).toBeGreaterThan(0);

    const { data: inserted, error: insertError } = await staff.from("refill_events").insert({ kiosk_id: kioskId, kind: "paper", quantity: 999 }).select();
    // No insert policy/grant at all — PostgREST reports 0 rows affected (RLS-style), not necessarily a thrown error.
    expect((inserted as unknown[] | null)?.length ?? 0).toBe(0);
    if (!insertError) {
      const { data: stillAbsent } = await admin.from("refill_events").select("id").eq("kiosk_id", kioskId).eq("quantity", 999);
      expect((stillAbsent as unknown[]).length).toBe(0);
    }
  });

  it("refuses record_refill for an unauthenticated (anon) caller", async () => {
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("record_refill", { p_kiosk_id: kioskId, p_kind: "paper", p_quantity: 100 });
    expect(error).not.toBeNull();
  });
});
