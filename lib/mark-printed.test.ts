import { beforeEach, describe, expect, it, vi } from "vitest";

// The corrective action for the fixed-timeout bug: a job that actually
// printed but got marked print_failed anyway. mark_job_printed_no_refund_
// needed (the RPC) does the atomic print_jobs state flip; this file's own
// job is making sure the SAME recordCompletedPrint revenue bookkeeping the
// print agent's success path uses actually runs afterward — that's the
// "if a refund is refused, it should show up in revenue" requirement.

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (): Promise<{ data: null; error: { message: string } | null }> => ({ data: null, error: null })),
  getJob: vi.fn(),
  recordCompletedPrint: vi.fn(async () => null),
}));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: mocks.rpc }) }));
vi.mock("./store", () => ({ getJob: mocks.getJob }));
vi.mock("./kiosk-stats", () => ({ recordCompletedPrint: mocks.recordCompletedPrint }));

import { markJobPrintedNoRefundNeeded } from "./mark-printed";

function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    kioskId: "oxway_01",
    totalPrice: 50,
    isFree: false,
    waivedAmount: null,
    originalJobId: undefined,
    sheetKind: "none",
    settings: { isColor: false, copies: 1, layout: "portrait", paperSize: "A4", pagesPerSheet: 1 },
    selectedPages: Array.from({ length: 60 }, (_, i) => i + 1),
    includeBannerPage: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe("markJobPrintedNoRefundNeeded", () => {
  it("refuses with the RPC's own reason and never records revenue when the atomic guard rejects it (e.g. already refunded)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "This job has already been refunded — cannot mark it printed instead." } });

    const result = await markJobPrintedNoRefundNeeded("job-1", "confirmed_at_tray");

    expect(result).toEqual({ ok: false, reason: "This job has already been refunded — cannot mark it printed instead." });
    expect(mocks.recordCompletedPrint).not.toHaveBeenCalled();
  });

  it("for a real paying customer job, records the job's own total_price as revenue — the actual 'refund refused' requirement", async () => {
    mocks.getJob.mockResolvedValue(makeJob({ totalPrice: 50 }));

    const result = await markJobPrintedNoRefundNeeded("job-1", "confirmed_at_tray");

    expect(result).toEqual({ ok: true });
    expect(mocks.recordCompletedPrint).toHaveBeenCalledWith("oxway_01", expect.objectContaining({
      amount: 50,
      isFree: false,
      isReprint: false,
      jobId: "job-1",
      pagesPrinted: 60,
    }));
  });

  it("for a free staff print, records zero revenue and passes the waived amount instead — never counts a free job as new revenue", async () => {
    mocks.getJob.mockResolvedValue(makeJob({ totalPrice: 0, isFree: true, waivedAmount: 20 }));

    await markJobPrintedNoRefundNeeded("job-1", "confirmed_at_tray");

    expect(mocks.recordCompletedPrint).toHaveBeenCalledWith("oxway_01", expect.objectContaining({
      amount: 0,
      isFree: true,
      waivedAmount: 20,
    }));
  });

  it("for a reprint, records zero revenue (it's compensating for an earlier failure, not a new sale)", async () => {
    mocks.getJob.mockResolvedValue(makeJob({ totalPrice: 0, originalJobId: "original-job-1" }));

    await markJobPrintedNoRefundNeeded("job-1", "confirmed_at_tray");

    expect(mocks.recordCompletedPrint).toHaveBeenCalledWith("oxway_01", expect.objectContaining({
      amount: 0,
      isReprint: true,
    }));
  });

  it("passes the actor through to the RPC for the audit entry", async () => {
    mocks.getJob.mockResolvedValue(makeJob());
    await markJobPrintedNoRefundNeeded("job-1", "confirmed_at_tray", { userId: "user-1", role: "owner", ip: "1.2.3.4", userAgent: "test" });

    expect(mocks.rpc).toHaveBeenCalledWith("mark_job_printed_no_refund_needed", {
      p_job_id: "job-1",
      p_reason: "confirmed_at_tray",
      p_actor_user_id: "user-1",
      p_actor_role: "owner",
      p_ip: "1.2.3.4",
      p_user_agent: "test",
    });
  });
});
