import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL tests against a real Supabase project for the audit log —
 * requirement #5: "append-only is enforced, staff and anonymous can't
 * read it." RLS/grant behavior can only be genuinely proven against a
 * real PostgREST + Postgres instance, not a mock — same reasoning as the
 * other two *.integration.test.ts files in this directory, which this
 * mirrors (down to the env var names — all three point at the same "dev
 * Supabase project," so one setup covers all of them).
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-14_audit_log.sql to a DEV
 *      Supabase project — never production.
 *   2. Set these two env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *      ...and this one, needed because the read/write-access tests sign
 *      in as real owner/staff test users with the ANON key, not the
 *      service-role key (which bypasses RLS entirely and would prove
 *      nothing about it):
 *        STAFF_PRINT_TEST_SUPABASE_ANON_KEY=<anon/publishable key>
 *   3. Run: npx vitest run supabase/audit-log.integration.test.ts
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
    "[audit-log] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL, STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY " +
    "and STAFF_PRINT_TEST_SUPABASE_ANON_KEY (a dev Supabase project with this feature's migration already " +
    "applied) to actually run these against a real database."
  );
}

const TEST_KIOSK_ID = `test_audit_${Date.now()}`;
const TEST_PASSWORD = "test-password-" + Math.random().toString(36).slice(2);

interface AuditLogRow {
  id: number;
  action: string;
  actor_user_id: string | null;
  details: Record<string, unknown> | null;
}

describe.skipIf(!hasCredentials)("audit_log (real Supabase)", () => {
  let admin: SupabaseClient;
  let ownerUserId: string;
  let staffUserId: string;
  let ownerEmail: string;
  let staffEmail: string;

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    await admin.from("kiosk_status").upsert({ id: TEST_KIOSK_ID });

    ownerEmail = `audit-owner-${Date.now()}@example.invalid`;
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "owner" },
    });
    if (ownerError || !owner.user) throw new Error(`Could not create test owner: ${ownerError?.message}`);
    ownerUserId = owner.user.id;

    staffEmail = `audit-staff-${Date.now()}@example.invalid`;
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: staffEmail, password: TEST_PASSWORD, email_confirm: true, app_metadata: { role: "staff" },
    });
    if (staffError || !staff.user) throw new Error(`Could not create test staff user: ${staffError?.message}`);
    staffUserId = staff.user.id;
  });

  afterAll(async () => {
    await admin.from("audit_log").delete().eq("kiosk_id", TEST_KIOSK_ID);
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

  it("lets an owner read audit_log", async () => {
    await admin.rpc("log_audit", { p_action: "test_owner_can_read", p_kiosk_id: TEST_KIOSK_ID });
    const owner = await signInAs(ownerEmail);

    const { data, error } = await owner.from("audit_log").select("*").eq("kiosk_id", TEST_KIOSK_ID);

    expect(error).toBeNull();
    expect((data as AuditLogRow[]).some((row) => row.action === "test_owner_can_read")).toBe(true);
  });

  it("gives staff zero rows, not an error — RLS denies, it doesn't fail the query", async () => {
    await admin.rpc("log_audit", { p_action: "test_staff_cannot_read", p_kiosk_id: TEST_KIOSK_ID });
    const staff = await signInAs(staffEmail);

    const { data, error } = await staff.from("audit_log").select("*").eq("kiosk_id", TEST_KIOSK_ID);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("gives an anonymous (signed-out) caller zero rows too", async () => {
    await admin.rpc("log_audit", { p_action: "test_anon_cannot_read", p_kiosk_id: TEST_KIOSK_ID });
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } });

    const { data, error } = await anon.from("audit_log").select("*").eq("kiosk_id", TEST_KIOSK_ID);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses an UPDATE from the owner — append-only means no update path, even for the one role that can read", async () => {
    await admin.rpc("log_audit", { p_action: "test_append_only_update", p_kiosk_id: TEST_KIOSK_ID });
    const { data: rows } = await admin.from("audit_log").select("id").eq("action", "test_append_only_update").eq("kiosk_id", TEST_KIOSK_ID).limit(1);
    const rowId = (rows as { id: number }[])[0].id;

    const owner = await signInAs(ownerEmail);
    const { data } = await owner.from("audit_log").update({ action: "tampered" }).eq("id", rowId).select();

    // No policy at all means PostgREST reports this as 0 rows updated, not
    // a permission error — either way, nothing must actually change.
    expect((data as unknown[] | null)?.length ?? 0).toBe(0);
    const { data: unchanged } = await admin.from("audit_log").select("action").eq("id", rowId).single();
    expect(unchanged!.action).toBe("test_append_only_update");
  });

  it("refuses a DELETE from the owner — the same append-only guarantee", async () => {
    await admin.rpc("log_audit", { p_action: "test_append_only_delete", p_kiosk_id: TEST_KIOSK_ID });
    const { data: rows } = await admin.from("audit_log").select("id").eq("action", "test_append_only_delete").eq("kiosk_id", TEST_KIOSK_ID).limit(1);
    const rowId = (rows as { id: number }[])[0].id;

    const owner = await signInAs(ownerEmail);
    await owner.from("audit_log").delete().eq("id", rowId);

    const { data: stillThere } = await admin.from("audit_log").select("id").eq("id", rowId).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it("refuses a direct, non-admin call to log_audit() itself — no grant to authenticated at all, not even for an owner", async () => {
    const owner = await signInAs(ownerEmail);
    const { error } = await owner.rpc("log_audit", { p_action: "should_never_be_insertable_directly" });
    expect(error).not.toBeNull();
  });

  it("writes a real before/after audit entry end to end through an actual RPC (update_pricing)", async () => {
    const owner = await signInAs(ownerEmail);
    const { data: before } = await admin.from("pricing_config").select("price_bw, price_color").eq("id", "default").single();

    const newBw = Number(before!.price_bw) + 1;
    const { error } = await owner.rpc("update_pricing", { p_price_bw: newBw, p_price_color: before!.price_color });
    expect(error).toBeNull();

    try {
      const { data: entries } = await admin
        .from("audit_log")
        .select("*")
        .eq("action", "pricing_updated")
        .order("id", { ascending: false })
        .limit(1);
      const entry = (entries as AuditLogRow[])[0];
      expect(entry.actor_user_id).toBe(ownerUserId);
      expect(entry.details?.after).toEqual({ price_bw: newBw, price_color: Number(before!.price_color) });
    } finally {
      // Restore the real price this dev project had before this test ran —
      // via the owner client, same as the real change above: update_pricing
      // checks current_app_role() off the caller's own JWT, which the
      // service-role admin client doesn't carry the same way.
      await owner.rpc("update_pricing", { p_price_bw: before!.price_bw, p_price_color: before!.price_color });
    }
  });
});
