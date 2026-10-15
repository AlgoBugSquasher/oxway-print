import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * REAL concurrency tests against a real Supabase project for
 * next_ticket_number() — same reasoning as
 * supabase/staff-print-concurrency.integration.test.ts (which this mirrors
 * exactly, down to the env var names — both point at the same "dev
 * Supabase project," so one setup covers both suites): the atomic
 * INSERT...ON CONFLICT...RETURNING counter and its print_jobs_kiosk_ticket_idx
 * unique-index backstop can only be genuinely proven correct under real
 * concurrent load against a real Postgres instance, not a mock.
 *
 * SKIPPED BY DEFAULT — there is no live test database wired into this
 * project's CI/dev environment. To actually run this suite:
 *
 *   1. Apply supabase/migrations/2026-10-14_ticket_number_kolkata_timezone.sql
 *      to a DEV Supabase project — never production.
 *   2. Set these two env vars to that project's own values (Project
 *      Settings -> API in the Supabase dashboard):
 *        STAFF_PRINT_TEST_SUPABASE_URL=https://<ref>.supabase.co
 *        STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role key>
 *   3. Run: npx vitest run supabase/ticket-number-concurrency.integration.test.ts
 *
 * Every row this suite touches is scoped to its own randomly-generated
 * kiosk ids, cleaned up in afterAll — safe to run repeatedly, and safe
 * against a project with other real data. Still: dev project only.
 */

const SUPABASE_URL = process.env.STAFF_PRINT_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY;
const hasCredentials = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

if (!hasCredentials) {
  console.warn(
    "[ticket-number-concurrency] SKIPPED — set STAFF_PRINT_TEST_SUPABASE_URL and " +
    "STAFF_PRINT_TEST_SUPABASE_SERVICE_ROLE_KEY (a dev Supabase project with this " +
    "feature's migration already applied) to actually run these against a real database."
  );
}

interface NextTicketRow {
  ticket_number: number;
  ticket_date: string;
}

/** One calendar day earlier than `dateStr` (a plain "YYYY-MM-DD", as next_ticket_number() itself returns) — plain date arithmetic, never a moment-in-time/timezone conversion, so this never needs to agree with any clock. */
function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!hasCredentials)("next_ticket_number() concurrency (real Supabase)", () => {
  let supabase: SupabaseClient;
  const createdKioskIds: string[] = [];

  beforeAll(() => {
    supabase = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  });

  afterAll(async () => {
    if (createdKioskIds.length > 0) {
      await supabase.from("kiosk_ticket_counters").delete().in("kiosk_id", createdKioskIds);
    }
  });

  function freshKioskId(label: string): string {
    const id = `test_ticket_${label}_${crypto.randomUUID()}`;
    createdKioskIds.push(id);
    return id;
  }

  async function nextTicket(kioskId: string): Promise<NextTicketRow> {
    const { data, error } = await supabase.rpc("next_ticket_number", { p_kiosk_id: kioskId });
    if (error) throw error;
    return (data as NextTicketRow[])[0];
  }

  it("gives many concurrent callers on the same kiosk a dense, gap-free, collision-free sequence (1..N) — real atomicity, not just real uniqueness", async () => {
    const kioskId = freshKioskId("parallel");
    const N = 20;

    const results = await Promise.all(Array.from({ length: N }, () => nextTicket(kioskId)));
    const numbers = results.map((r) => r.ticket_number).sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(N); // no two callers ever got the same number
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // 1..N exactly — no gaps, no number skipped or reused
    // Every caller agreed on the same ticket_date too (same kiosk, same instant-ish window).
    expect(new Set(results.map((r) => r.ticket_date)).size).toBe(1);
  });

  it("rolls over past 999 into 1000, 1001, ... with no reset, no truncation, and no collision with the padded 3-digit display format", async () => {
    const kioskId = freshKioskId("rollover");

    const first = await nextTicket(kioskId); // seeds today's row and reads back the real ticket_date
    expect(first.ticket_number).toBe(1);

    const { error: primeError } = await supabase
      .from("kiosk_ticket_counters")
      .update({ last_number: 999 })
      .eq("kiosk_id", kioskId)
      .eq("ticket_date", first.ticket_date);
    if (primeError) throw primeError;

    const rollover = await nextTicket(kioskId);
    expect(rollover.ticket_number).toBe(1000);
    expect(rollover.ticket_date).toBe(first.ticket_date);

    const afterRollover = await nextTicket(kioskId);
    expect(afterRollover.ticket_number).toBe(1001);
  });

  it("starts a fresh sequence at 1 on a day change, independent of whatever number yesterday's counter reached — never leaks across the date boundary", async () => {
    const kioskId = freshKioskId("day-change");

    const todayFirst = await nextTicket(kioskId); // today's row now exists, at 1
    expect(todayFirst.ticket_number).toBe(1);

    // A separate row for "yesterday," left mid-sequence — simulates a kiosk
    // that printed 50 jobs yesterday. next_ticket_number() itself always
    // computes its own "today" (Asia/Kolkata) and can't be asked for a
    // different day directly, so this test instead proves the mechanism
    // that WOULD make today's reset work on a real day change: the primary
    // key is (kiosk_id, ticket_date), so an old date's row can never be the
    // one a new day's ON CONFLICT matches against.
    const yesterday = dayBefore(todayFirst.ticket_date);
    const { error: seedError } = await supabase
      .from("kiosk_ticket_counters")
      .insert({ kiosk_id: kioskId, ticket_date: yesterday, last_number: 50 });
    if (seedError) throw seedError;

    const todaySecond = await nextTicket(kioskId);
    expect(todaySecond.ticket_number).toBe(2); // continues today's own 1 -> 2, never jumps to 51
    expect(todaySecond.ticket_date).toBe(todayFirst.ticket_date);

    // Yesterday's row is untouched by any of today's calls.
    const { data: yesterdayRow, error: readError } = await supabase
      .from("kiosk_ticket_counters")
      .select("last_number")
      .eq("kiosk_id", kioskId)
      .eq("ticket_date", yesterday)
      .single();
    if (readError) throw readError;
    expect(yesterdayRow.last_number).toBe(50);
  });

  it("keeps each kiosk's sequence fully independent — two kiosks calling concurrently never share or skip numbers", async () => {
    const kioskA = freshKioskId("independent-a");
    const kioskB = freshKioskId("independent-b");
    const N = 10;

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(Array.from({ length: N }, () => nextTicket(kioskA))),
      Promise.all(Array.from({ length: N }, () => nextTicket(kioskB))),
    ]);

    const numbersA = resultsA.map((r) => r.ticket_number).sort((a, b) => a - b);
    const numbersB = resultsB.map((r) => r.ticket_number).sort((a, b) => a - b);
    expect(numbersA).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(numbersB).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
