import { beforeEach, describe, expect, it, vi } from "vitest";

// Requirement #7: "Reprint pages" (admin-only) test coverage —
//   - staff blocked: the REAL server-side authorization boundary, same
//     pattern app/api/staff-print/route.test.ts already establishes for
//     its own route (every dependency mocked, POST called directly).
//   - deleted file: downloadJobPdf throwing surfaces as a clear,
//     specific "file removed" message, not a generic 500.
//   - refund conflict: an already-refunded original job is blocked
//     before any PDF work ever happens.
//   - reprint with a page range: a contiguous selection is accepted,
//     validated against the real page count, and the final settings
//     correctly inherit the original's layout/color/paper size while
//     only copies is overridden.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getJob: vi.fn(),
  downloadJobPdf: vi.fn(async () => new Uint8Array([1, 2, 3])),
  extractSelectedPages: vi.fn(async (_bytes: Uint8Array, pages: number[]) => ({ bytes: new Uint8Array([9]), pageCount: pages.length })),
  uploadJobPdf: vi.fn(async (jobId: string) => `${jobId}.pdf`),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- parameter typed so .mock.calls[i][0] below is `string`, not `unknown`
  deleteStorageObject: vi.fn(async (_path: string) => {}),
  createReprintJob: vi.fn(async (input: { jobId: string; originalJobId: string; includeBannerPage: boolean; settings: Record<string, unknown>; reprintNote: string; forceCoverSheet: boolean }) => ({ id: input.jobId, ticketNumber: 11 })),
}));

// Same reasoning app/api/staff-print/route.test.ts's own comment gives:
// no vitest.config.ts wires up the "@/" alias outside Next.js/tsconfig,
// so every vi.mock target below is a plain, self-contained factory.
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/print/pdf", () => ({ extractSelectedPages: mocks.extractSelectedPages }));
// formatReprintNote is pure (no dependencies of its own) — left real rather
// than mocked, so the "reprint with a page range" test below genuinely
// proves the route calls it correctly, not just that it calls A function.
// Imported by a RELATIVE path here (not "@/...") specifically so this one
// mock factory can actually resolve the real module on disk — the "@/"
// alias itself only resolves via Next.js/tsconfig, never through vitest.
vi.mock("@/lib/print/reprint-note", async () => await import("../../../../lib/print/reprint-note"));
vi.mock("@/lib/store", () => ({
  getJob: mocks.getJob,
  downloadJobPdf: mocks.downloadJobPdf,
  uploadJobPdf: mocks.uploadJobPdf,
  deleteStorageObject: mocks.deleteStorageObject,
  createReprintJob: mocks.createReprintJob,
}));

import { POST } from "./route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/reprint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeUser(role: string | undefined) {
  return { id: "owner-1", app_metadata: role !== undefined ? { role } : {} };
}

function makeOriginalJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "original-job-1",
    fileName: "handout.pdf",
    selectedPages: [1, 2, 3, 4, 5],
    settings: { copies: 1, layout: "portrait", isColor: true, paperSize: "A4", pagesPerSheet: 1 },
    pdfStoragePath: "original-job-1.pdf",
    contentHash: "hash-1",
    refundStatus: undefined,
    ...overrides,
  };
}

const validBody = { originalJobId: "original-job-1", selectedPages: [2, 3, 4], copies: 2, forceCoverSheet: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getJob.mockResolvedValue(makeOriginalJob());
  mocks.downloadJobPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.extractSelectedPages.mockImplementation(async (_bytes: Uint8Array, pages: number[]) => ({ bytes: new Uint8Array([9]), pageCount: pages.length }));
  mocks.uploadJobPdf.mockImplementation(async (jobId: string) => `${jobId}.pdf`);
  mocks.createReprintJob.mockImplementation(async (input: { jobId: string; originalJobId: string; includeBannerPage: boolean; settings: Record<string, unknown>; reprintNote: string; forceCoverSheet: boolean }) => ({ id: input.jobId, ticketNumber: 11 }));
});

describe("POST /api/admin/reprint — authorization (staff blocked)", () => {
  it("rejects an anonymous request with 403, never reaching createReprintJob", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createReprintJob).not.toHaveBeenCalled();
  });

  it("rejects a signed-in STAFF user — this feature is owner-only, unlike the plain 'Reprint' (force_reprint_job) button", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("staff") } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createReprintJob).not.toHaveBeenCalled();
    expect(mocks.getJob).not.toHaveBeenCalled();
  });

  it("allows a signed-in owner", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("owner") } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(200);
    expect(mocks.createReprintJob).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/admin/reprint — request handling", () => {
  beforeEach(() => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("owner") } });
  });

  it("refund conflict: blocks reprinting an already-refunded original job before downloading anything", async () => {
    mocks.getJob.mockResolvedValue(makeOriginalJob({ refundStatus: "refunded" }));
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/already been refunded/i);
    expect(mocks.downloadJobPdf).not.toHaveBeenCalled();
    expect(mocks.createReprintJob).not.toHaveBeenCalled();
  });

  it("deleted file: a removed stored PDF surfaces as a clear message, not a generic 500", async () => {
    mocks.downloadJobPdf.mockRejectedValue(new Error("Could not download print PDF: not found"));
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.error).toMatch(/removed/i);
    expect(mocks.createReprintJob).not.toHaveBeenCalled();
  });

  it("rejects a page number beyond the job's real page count, before ever downloading the file", async () => {
    mocks.getJob.mockResolvedValue(makeOriginalJob({ selectedPages: [1, 2, 3] })); // real page count = 3
    const response = await POST(makeRequest({ ...validBody, selectedPages: [2, 3, 7] }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/page 7/i);
    expect(mocks.downloadJobPdf).not.toHaveBeenCalled();
  });

  it("reprint with a page range: a contiguous selection is extracted, uploaded, and the final settings inherit layout/color/paper size from the original with only copies overridden", async () => {
    mocks.getJob.mockResolvedValue(makeOriginalJob({ settings: { copies: 1, layout: "landscape", isColor: true, paperSize: "Legal", pagesPerSheet: 2 } }));
    const response = await POST(makeRequest({ originalJobId: "original-job-1", selectedPages: [2, 3, 4], copies: 3, forceCoverSheet: true }));

    expect(response.status).toBe(200);
    expect(mocks.extractSelectedPages).toHaveBeenCalledWith(expect.anything(), [2, 3, 4], "landscape");

    const call = mocks.createReprintJob.mock.calls[0][0];
    expect(call.originalJobId).toBe("original-job-1");
    expect(call.forceCoverSheet).toBe(true);
    // Only copies changes — layout/color/paperSize/pagesPerSheet carry over untouched.
    expect(call.settings).toEqual({ copies: 3, layout: "landscape", isColor: true, paperSize: "Legal", pagesPerSheet: 2 });
    expect(call.reprintNote).toMatch(/reprinted pages? 2 to 4/i);
  });

  it("cleans up the freshly-uploaded reprint PDF if createReprintJob itself then fails (e.g. the RPC's own atomic re-check rejects it)", async () => {
    mocks.createReprintJob.mockRejectedValue(new Error("This job has already been refunded."));
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(500);
    expect(mocks.deleteStorageObject).toHaveBeenCalledWith(expect.stringContaining(".pdf"));
  });
});
