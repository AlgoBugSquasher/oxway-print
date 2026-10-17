import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsMatch } from "./store";

// Highest-risk logic per ROADMAP.md #14: the atomic UPDATE ... WHERE status = X
// guards (claimJobAsPaid, expireJobIfPending, deleteJob) are the entire
// mechanism preventing double-printing and duplicate notifications
// (ROADMAP.md §11). A refactor that silently drops the status check
// wouldn't fail typecheck or a happy-path manual test — it would only show
// up as a real double-print under concurrent load. These tests assert the
// actual query chain includes the guard, not just that the function
// compiles and returns *a* value.
//
// claimNextPaidJob and createStaffPrintJob (the free-staff-print feature)
// are both thin wrappers around Postgres RPCs that do their OWN atomic
// claiming/locking (claim_next_paid_job's SELECT ... FOR UPDATE SKIP
// LOCKED, create_staff_print_job's single-transaction idempotency/cap/
// ticket/insert sequence — see supabase/migrations/2026-10-14_staff_print.sql)
// — the real correctness guarantee lives in that SQL, not in this TypeScript
// wrapper, so these tests only check the RPC is called with the right name
// and arguments, the same scope assignTicketNumber's own tests below cover.

/** Records every chained call so assertions can check exactly what query was built, then resolves like a real Supabase query when awaited. */
function createMockQueryBuilder(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const CHAIN_METHODS = ["from", "select", "update", "delete", "insert", "eq", "neq", "in", "lt", "lte", "gt", "gte", "or", "order", "limit", "single", "maybeSingle"];
  const builder: Record<string, unknown> = { __calls: calls };
  for (const method of CHAIN_METHODS) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => resolve(result);
  return builder as { __calls: typeof calls } & Record<string, (...args: unknown[]) => unknown>;
}

const mockAdmin = vi.hoisted(() => ({
  current: null as ReturnType<typeof createMockQueryBuilder> | null,
  // Only used by tests that issue more than one DIFFERENT .from() query in
  // the same call (e.g. listJobsEligibleForCleanup's Promise.all of two
  // separate queries) — each .from() call shifts the next builder off this
  // queue instead of all resolving to the single shared `current` above.
  // Empty (the default) for every other test, which keeps using `current`
  // exactly as before.
  fromQueue: [] as ReturnType<typeof createMockQueryBuilder>[],
  // Separate from `current` (the .from() query builder) since assignTicketNumber
  // goes through .rpc(), a different call shape entirely.
  rpcResult: null as { data: unknown; error: unknown } | null,
  rpcCalls: [] as { name: string; args: unknown }[],
  // listStaleTempUploads' own input — defaults to "nothing in storage" so
  // every other test in this file (which never touches it) doesn't need
  // its own stub.
  storageListResult: { data: [] as unknown[] | null, error: null as unknown },
  storageRemoveCalls: [] as string[][],
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: () => (mockAdmin.fromQueue.length > 0 ? mockAdmin.fromQueue.shift() : mockAdmin.current),
    storage: {
      from: () => ({
        // deleteJob/deleteStorageObject remove the Storage object after a
        // successful row delete — stubbed as a no-op success so most tests
        // don't need their own dedicated mock, while still recording which
        // paths were asked for (listStaleTempUploads' own tests check this).
        remove: async (paths: string[]) => {
          mockAdmin.storageRemoveCalls.push(paths);
          return { error: null };
        },
        list: async () => mockAdmin.storageListResult,
      }),
    },
    rpc: async (name: string, args: unknown) => {
      mockAdmin.rpcCalls.push({ name, args });
      return mockAdmin.rpcResult;
    },
  }),
}));

describe("settingsMatch", () => {
  const base = { copies: 1, layout: "portrait" as const, isColor: false, paperSize: "A4" as const, pagesPerSheet: 1 as const };

  it("matches identical settings", () => {
    expect(settingsMatch(base, { ...base })).toBe(true);
  });

  it("does not match when any field differs", () => {
    expect(settingsMatch(base, { ...base, copies: 2 })).toBe(false);
    expect(settingsMatch(base, { ...base, isColor: true })).toBe(false);
    expect(settingsMatch(base, { ...base, layout: "landscape" })).toBe(false);
  });

  it("is not fooled by key order — the exact bug a JSON.stringify comparison had", () => {
    // Same values, deliberately different construction order — this is what
    // a jsonb round-trip through Postgres can produce even for identical data.
    const reordered = { pagesPerSheet: 1 as const, paperSize: "A4" as const, isColor: false, layout: "portrait" as const, copies: 1 };
    expect(settingsMatch(base, reordered)).toBe(true);
  });
});

describe("atomic status-guarded store functions", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.current = null;
  });

  it("claimJobAsPaid guards on status = 'pending_payment'", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "paid" }, error: null });
    const { claimJobAsPaid } = await import("./store");
    await claimJobAsPaid("job-1", {});
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "pending_payment"] });
  });

  it("claimJobAsPaid returns null (not throw) when the guard matched zero rows", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: null, error: null });
    const { claimJobAsPaid } = await import("./store");
    await expect(claimJobAsPaid("job-1", {})).resolves.toBeNull();
  });

  it("expireJobIfPending guards on status = 'pending_payment'", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "expired" }, error: null });
    const { expireJobIfPending } = await import("./store");
    await expireJobIfPending("job-1");
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "pending_payment"] });
  });

  it("deleteJob guards on the exact status it was told the job was in, not just the id", async () => {
    mockAdmin.current = createMockQueryBuilder({ data: [{ id: "job-1" }], error: null });
    const { deleteJob } = await import("./store");
    await deleteJob({ id: "job-1", status: "printed", pdfStoragePath: "job-1.pdf" });
    const eqCalls = mockAdmin.current.__calls.filter((call) => call.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "printed"] });
  });

  it("deleteJob backs off (returns false) instead of deleting when the row's status already changed", async () => {
    // Empty array = the WHERE (id AND status) matched nothing — the atomic guard did its job.
    mockAdmin.current = createMockQueryBuilder({ data: [], error: null });
    const { deleteJob } = await import("./store");
    await expect(deleteJob({ id: "job-1", status: "printed", pdfStoragePath: "job-1.pdf" })).resolves.toBe(false);
  });

  // "a job that printed after being marked failed" — the exact scenario
  // this guard exists to make impossible: failPrintingJob must only ever
  // move a job OUT of 'printing'/'print_blocked', never overwrite a job
  // that's already reached 'printed' (or any other terminal state) by the
  // time this write actually runs.
  describe("failPrintingJob", () => {
    it("guards on status IN ('printing', 'print_blocked'), not a bare id match", async () => {
      mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "print_failed" }, error: null });
      const { failPrintingJob } = await import("./store");
      await failPrintingJob("job-1", "stuck");
      const inCalls = mockAdmin.current.__calls.filter((call) => call.method === "in");
      expect(inCalls).toContainEqual({ method: "in", args: ["status", ["printing", "print_blocked"]] });
    });

    it("clears blocked_reason back to null in the same write", async () => {
      mockAdmin.current = createMockQueryBuilder({ data: { id: "job-1", status: "print_failed" }, error: null });
      const { failPrintingJob } = await import("./store");
      await failPrintingJob("job-1", "stuck");
      const updateCalls = mockAdmin.current.__calls.filter((call) => call.method === "update");
      expect(updateCalls[0]?.args[0]).toMatchObject({ status: "print_failed", error: "stuck", blocked_reason: null });
    });

    it("never changes a job to print_failed if it already reached 'printed' — the guard matches zero rows and this returns null rather than throwing or retrying", async () => {
      // Empty result = the WHERE (id AND status IN (...)) matched nothing
      // — exactly what happens when the SAME physically-buffered job
      // already finished printing (and the DB already reflects 'printed')
      // by the moment this write runs.
      mockAdmin.current = createMockQueryBuilder({ data: null, error: null });
      const { failPrintingJob } = await import("./store");
      await expect(failPrintingJob("job-1", "stuck")).resolves.toBeNull();
    });
  });
});

// ROADMAP.md §21 — new for v2.5, ported nothing here so there's no v2 test
// to have carried forward. The one correctness property that matters: the
// kiosk id actually reaches next_ticket_number(), and the number/date
// next_ticket_number() returns are what the caller gets back untouched —
// not recomputed, not defaulted, not silently dropped on a partial result.
describe("assignTicketNumber", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.rpcResult = null;
    mockAdmin.rpcCalls = [];
  });

  it("calls next_ticket_number with the given kiosk id and returns its result untouched", async () => {
    mockAdmin.rpcResult = { data: [{ ticket_number: 42, ticket_date: "2026-01-15" }], error: null };
    const { assignTicketNumber } = await import("./store");

    const result = await assignTicketNumber("oxway_02");

    expect(mockAdmin.rpcCalls).toEqual([{ name: "next_ticket_number", args: { p_kiosk_id: "oxway_02" } }]);
    expect(result).toEqual({ ticketNumber: 42, ticketDate: "2026-01-15" });
  });

  it("throws rather than silently returning a bad ticket number when the RPC errors", async () => {
    mockAdmin.rpcResult = { data: null, error: { message: "connection reset" } };
    const { assignTicketNumber } = await import("./store");
    await expect(assignTicketNumber("oxway_01")).rejects.toThrow("connection reset");
  });

  it("throws when the RPC returns no rows — a silent fallback here would mean two jobs could end up with no ticket number instead of failing loudly", async () => {
    mockAdmin.rpcResult = { data: [], error: null };
    const { assignTicketNumber } = await import("./store");
    await expect(assignTicketNumber("oxway_01")).rejects.toThrow();
  });
});

describe("claimNextPaidJob", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.rpcResult = null;
    mockAdmin.rpcCalls = [];
  });

  it("calls claim_next_paid_job with the given kiosk id and maps the returned row", async () => {
    mockAdmin.rpcResult = {
      data: [{ id: "job-1", status: "printing", selected_pages: [1], settings: {}, total_price: 2, phone_number: "", notify_opt_in: false, include_banner_page: true, content_hash: "h", provider: "razorpay", provider_order_id: "o", provider_meta: null, pdf_storage_path: "job-1.pdf", kiosk_id: "oxway_01", created_at: "now", updated_at: "now", error: null, cups_job_id: null, refunded_at: null, ticket_number: 1, ticket_date: "2026-01-15", payment_id: null, upi_txn_id: null, paid_amount: null, payment_method: "razorpay", created_by_user_id: null, is_free: false, waived_amount: null, idempotency_key: null, queue_time: "now", file_name: "f.pdf" }],
      error: null,
    };
    const { claimNextPaidJob } = await import("./store");

    const result = await claimNextPaidJob("oxway_02");

    expect(mockAdmin.rpcCalls).toEqual([{ name: "claim_next_paid_job", args: { p_kiosk_id: "oxway_02" } }]);
    expect(result?.id).toBe("job-1");
    expect(result?.status).toBe("printing");
  });

  it("returns null (not throw) when the queue is empty — the agent's own drain loop relies on this to know when to stop", async () => {
    mockAdmin.rpcResult = { data: [], error: null };
    const { claimNextPaidJob } = await import("./store");
    await expect(claimNextPaidJob("oxway_01")).resolves.toBeNull();
  });

  it("throws rather than silently treating an RPC error as an empty queue", async () => {
    mockAdmin.rpcResult = { data: null, error: { message: "connection reset" } };
    const { claimNextPaidJob } = await import("./store");
    await expect(claimNextPaidJob("oxway_01")).rejects.toThrow("connection reset");
  });
});

describe("createStaffPrintJob", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.rpcResult = null;
    mockAdmin.rpcCalls = [];
  });

  function makeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-staff-1", status: "paid", file_name: "f.pdf", selected_pages: [1, 2], settings: {}, total_price: 0,
      phone_number: "", notify_opt_in: false, include_banner_page: true, content_hash: "h",
      provider: "razorpay", provider_order_id: "", provider_meta: null, pdf_storage_path: "job-staff-1.pdf",
      kiosk_id: "oxway_01", created_at: "now", updated_at: "now", error: null, cups_job_id: null, refunded_at: null,
      ticket_number: 5, ticket_date: "2026-01-15", payment_id: null, upi_txn_id: null, paid_amount: null,
      payment_method: "staff", created_by_user_id: "user-1", is_free: true, waived_amount: 12, idempotency_key: "key-1",
      queue_time: "now",
      ...overrides,
    };
  }

  const baseInput = {
    jobId: "job-staff-1",
    fileName: "f.pdf",
    selectedPages: [1, 2],
    settings: { copies: 1, layout: "portrait" as const, isColor: false, paperSize: "A4" as const, pagesPerSheet: 1 as const },
    waivedAmount: 12,
    contentHash: "h",
    provider: "razorpay" as const,
    pdfStoragePath: "job-staff-1.pdf",
    kioskId: "oxway_01",
    idempotencyKey: "key-1",
    createdByUserId: "user-1",
    dailyCap: 500,
  };

  it("calls create_staff_print_job with every field mapped to its p_-prefixed RPC argument", async () => {
    mockAdmin.rpcResult = { data: [makeRow()], error: null };
    const { createStaffPrintJob } = await import("./store");

    const result = await createStaffPrintJob(baseInput);

    expect(mockAdmin.rpcCalls).toEqual([{
      name: "create_staff_print_job",
      args: {
        p_job_id: "job-staff-1",
        p_file_name: "f.pdf",
        p_selected_pages: [1, 2],
        p_settings: baseInput.settings,
        p_waived_amount: 12,
        p_content_hash: "h",
        p_provider: "razorpay",
        p_pdf_storage_path: "job-staff-1.pdf",
        p_kiosk_id: "oxway_01",
        p_idempotency_key: "key-1",
        p_created_by: "user-1",
        p_daily_cap: 500,
      },
    }]);
    expect(result.id).toBe("job-staff-1");
    expect(result.paymentMethod).toBe("staff");
    expect(result.isFree).toBe(true);
    expect(result.waivedAmount).toBe(12);
    expect(result.totalPrice).toBe(0);
  });

  it("passes a null idempotency key through unchanged when the caller sent none", async () => {
    mockAdmin.rpcResult = { data: [makeRow({ idempotency_key: null })], error: null };
    const { createStaffPrintJob } = await import("./store");
    await createStaffPrintJob({ ...baseInput, idempotencyKey: null });
    expect(mockAdmin.rpcCalls[0].args).toMatchObject({ p_idempotency_key: null });
  });

  it("throws (surfacing the daily-cap exception message) rather than silently returning nothing", async () => {
    mockAdmin.rpcResult = { data: null, error: { message: "Daily staff print cap reached (520 of 500 pages used today)." } };
    const { createStaffPrintJob } = await import("./store");
    await expect(createStaffPrintJob(baseInput)).rejects.toThrow(/Daily staff print cap reached/);
  });

  it("throws rather than silently returning a half-built record when the RPC returns no row", async () => {
    mockAdmin.rpcResult = { data: [], error: null };
    const { createStaffPrintJob } = await import("./store");
    await expect(createStaffPrintJob(baseInput)).rejects.toThrow();
  });
});

// listStaleTempUploads is the only thing standing between a customer who
// uploads a file and then closes the tab (see app/api/create-upload-url)
// and that raw upload sitting in Supabase Storage forever — getting the
// age comparison backwards here would either sweep uploads that are still
// genuinely mid-checkout, or (the actual regression risk) never sweep
// anything at all.
describe("listStaleTempUploads", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.storageListResult = { data: [], error: null };
  });

  it("returns only uploads older than the cutoff, with the 'uploads/' prefix restored", async () => {
    const now = Date.now();
    mockAdmin.storageListResult = {
      data: [
        { name: "old-upload.pdf", created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
        { name: "fresh-upload.pdf", created_at: new Date(now - 60 * 1000).toISOString() },
      ],
      error: null,
    };
    const { listStaleTempUploads } = await import("./store");

    const stale = await listStaleTempUploads(60 * 60 * 1000); // 1 hour

    expect(stale).toEqual(["uploads/old-upload.pdf"]);
  });

  it("throws rather than silently treating a list failure as 'nothing to clean up'", async () => {
    mockAdmin.storageListResult = { data: null, error: { message: "network error" } };
    const { listStaleTempUploads } = await import("./store");
    await expect(listStaleTempUploads(60 * 60 * 1000)).rejects.toThrow("network error");
  });
});

describe("listJobsEligibleForCleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAdmin.current = null;
    mockAdmin.fromQueue = [];
  });

  // The refund approval workflow (task requirement: a pending/processing/
  // failed refund must never be cleaned up out from under the Refunds
  // admin page) means the terminal-jobs query now carries an extra
  // `.or(...)` filter on top of its existing `.in()`/`.lt()` — this
  // asserts that filter is actually present in the real query chain, not
  // just that the function compiles and returns *a* value (same reasoning
  // this file's own top comment already gives for the atomic-claim tests).
  it("includes an or() filter excluding unresolved refund_status from the terminal-jobs query", async () => {
    const terminalBuilder = createMockQueryBuilder({ data: [], error: null });
    const abandonedBuilder = createMockQueryBuilder({ data: [], error: null });
    mockAdmin.fromQueue = [terminalBuilder, abandonedBuilder];

    const { listJobsEligibleForCleanup } = await import("./store");
    await listJobsEligibleForCleanup();

    const orCalls = terminalBuilder.__calls.filter((call) => call.method === "or");
    expect(orCalls).toEqual([{ method: "or", args: ["refund_status.is.null,refund_status.eq.refunded"] }]);
    // The abandoned (pending_payment) query is unrelated to refunds — never needs this filter.
    expect(abandonedBuilder.__calls.some((call) => call.method === "or")).toBe(false);
  });

  it("still returns the rows both queries resolve with, combined", async () => {
    mockAdmin.fromQueue = [
      createMockQueryBuilder({ data: [{ id: "terminal-1", status: "print_failed", selected_pages: [1], settings: {}, total_price: 1, phone_number: "", notify_opt_in: false, include_banner_page: true, content_hash: "h", provider: "razorpay", provider_order_id: "o", provider_meta: null, pdf_storage_path: "p", kiosk_id: "oxway_01", created_at: "now", updated_at: "now", error: null, cups_job_id: null, refunded_at: null, refund_status: "refunded", refund_requested_at: null, refunded_by: null, refund_provider_id: null, refund_error: null, ticket_number: 1, ticket_date: "2026-01-15", payment_id: null, upi_txn_id: null, paid_amount: null, payment_method: "razorpay", created_by_user_id: null, is_free: false, waived_amount: null, idempotency_key: null, queue_time: null, file_name: "f.pdf" }], error: null }),
      createMockQueryBuilder({ data: [{ id: "abandoned-1", status: "pending_payment", selected_pages: [1], settings: {}, total_price: 1, phone_number: "", notify_opt_in: false, include_banner_page: true, content_hash: "h", provider: "razorpay", provider_order_id: "o", provider_meta: null, pdf_storage_path: "p", kiosk_id: "oxway_01", created_at: "now", updated_at: "now", error: null, cups_job_id: null, refunded_at: null, refund_status: null, refund_requested_at: null, refunded_by: null, refund_provider_id: null, refund_error: null, ticket_number: null, ticket_date: null, payment_id: null, upi_txn_id: null, paid_amount: null, payment_method: null, created_by_user_id: null, is_free: false, waived_amount: null, idempotency_key: null, queue_time: null, file_name: "f2.pdf" }], error: null }),
    ];

    const { listJobsEligibleForCleanup } = await import("./store");
    const jobs = await listJobsEligibleForCleanup();

    expect(jobs.map((job) => job.id).sort()).toEqual(["abandoned-1", "terminal-1"]);
  });
});
