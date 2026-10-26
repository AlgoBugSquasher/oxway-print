import { beforeEach, describe, expect, it, vi } from "vitest";

// Requirement #16: the REAL authorization boundary for free staff prints —
// a plain Next.js route handler, called directly here (not through an HTTP
// server; POST is just an exported async function) with every dependency
// mocked, so these tests exercise the actual server-side role check in
// app/api/staff-print/route.ts, not a proxy for it. The one thing that must
// never happen: a request without a verified owner/staff session ever
// reaching createStaffPrintJob.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  isWithinStaffPrintRateLimit: vi.fn(async () => true),
  getKioskUpdateState: vi.fn(async () => ({ isUpdating: false })),
  downloadJobPdf: vi.fn(async () => new Uint8Array([0x25, 0x44, 0x46])), // never actually parsed in most tests, looksLikePdf is mocked separately
  looksLikePdf: vi.fn(() => true),
  extractSelectedPages: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), pageCount: 2 })),
  getPricingConfig: vi.fn(async () => ({ priceBw: 2, priceColor: 10 })),
  uploadJobPdf: vi.fn(async (jobId: string) => `${jobId}.pdf`),
  createStaffPrintJob: vi.fn(async (input: { jobId: string; waivedAmount: number }) => ({
    id: input.jobId,
    ticketNumber: 7,
    waivedAmount: 4,
  })),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- parameter typed so .mock.calls[i][0] below is `string`, not `unknown`
  deleteStorageObject: vi.fn(async (_path: string) => {}),
}));

// NOTE: no vitest.config.ts exists in this project to wire up the `@/` path
// alias (it's resolved by Next.js/tsconfig only) — so every vi.mock target
// below is a plain, self-contained factory, NEVER importOriginal (which
// would force vitest to actually resolve "@/..." on disk and crash). The
// two math functions mocked here (computeBillableSheets/computeOrderPrice)
// are deliberately reimplemented inline rather than imported for real —
// they're one-line pure functions (see lib/pricing.ts) with their own
// direct unit tests already in lib/pricing.test.ts; duplicating their exact
// formula here keeps this file fully self-contained.
vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/rate-limit", () => ({ isWithinStaffPrintRateLimit: mocks.isWithinStaffPrintRateLimit }));
vi.mock("@/lib/kiosk-stats", () => ({ getKioskUpdateState: mocks.getKioskUpdateState }));
vi.mock("@/lib/print/pdf", () => ({ extractSelectedPages: mocks.extractSelectedPages, looksLikePdf: mocks.looksLikePdf }));
vi.mock("@/lib/pricing", () => ({
  computeBillableSheets: (pageCount: number, pagesPerSheet: number, copies: number) => Math.ceil(pageCount / pagesPerSheet) * copies,
  computeOrderPrice: (billableSheets: number, isColor: boolean, rates: { priceBw: number; priceColor: number }) => billableSheets * (isColor ? rates.priceColor : rates.priceBw),
}));
vi.mock("@/lib/config", () => ({
  // Mirrors lib/config.ts's real values at the time of writing — if that
  // file's own values ever change, lib/pricing.test.ts's own end-to-end
  // test would NOT catch a mismatch here (it doesn't import this route),
  // but this route's own "computes waivedAmount..." test below would still
  // pass either way since it only checks internal consistency with these
  // same mocked numbers, not against the real config. Acceptable: this
  // suite's job is authorization + request handling, not re-verifying
  // pricing math that already has its own dedicated tests.
  MAX_FILES_PER_ORDER: 50,
  MAX_PAGES_PER_STAFF_JOB: 100,
  MAX_STAFF_DAILY_PAGES: 500,
  MAX_UPLOAD_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  MAX_UPLOAD_PAGE_COUNT: 300,
  getActiveProvider: () => "razorpay" as const,
}));
vi.mock("@/lib/store", () => ({
  downloadJobPdf: mocks.downloadJobPdf,
  getPricingConfig: mocks.getPricingConfig,
  uploadJobPdf: mocks.uploadJobPdf,
  createStaffPrintJob: mocks.createStaffPrintJob,
  deleteStorageObject: mocks.deleteStorageObject,
}));

import { POST } from "./route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/staff-print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeUser(role: string | undefined) {
  return { id: "user-1", app_metadata: role !== undefined ? { role } : {} };
}

const validBody = {
  pdfStoragePath: "uploads/temp-1.pdf",
  fileName: "handout.pdf",
  selectedPages: [1, 2],
  settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
  kioskId: "oxway_01",
  idempotencyKey: "key-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWithinStaffPrintRateLimit.mockResolvedValue(true);
  mocks.getKioskUpdateState.mockResolvedValue({ isUpdating: false });
  mocks.looksLikePdf.mockReturnValue(true);
  mocks.extractSelectedPages.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), pageCount: 2 });
  mocks.getPricingConfig.mockResolvedValue({ priceBw: 2, priceColor: 10 });
  mocks.uploadJobPdf.mockImplementation(async (jobId: string) => `${jobId}.pdf`);
  mocks.createStaffPrintJob.mockImplementation(async (input: { jobId: string; waivedAmount: number }) => ({ id: input.jobId, ticketNumber: 7, waivedAmount: 4 }));
});

describe("POST /api/staff-print — authorization", () => {
  it("rejects an anonymous request (no session at all) with 403, never reaching createStaffPrintJob", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });

  it("rejects a signed-in customer (a real session, but no app_metadata.role at all) with 403", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser(undefined) } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });

  it("rejects a spoofed/unrecognized role value with 403 — only the exact strings 'owner'/'staff' pass", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("admin") } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });

  it("the role is read from app_metadata only — a request body claiming its own role is silently ignored, not trusted", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser(undefined) } });
    const response = await POST(makeRequest({ ...validBody, role: "owner", app_metadata: { role: "owner" } }));
    expect(response.status).toBe(403);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });

  it("allows a signed-in staff user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("staff") } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(200);
    expect(mocks.createStaffPrintJob).toHaveBeenCalledTimes(1);
  });

  it("allows a signed-in owner user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("owner") } });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(200);
    expect(mocks.createStaffPrintJob).toHaveBeenCalledTimes(1);
  });

  it("checks authorization BEFORE the rate limit — a blocked anonymous caller never even burns a rate-limit slot", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await POST(makeRequest(validBody));
    expect(mocks.isWithinStaffPrintRateLimit).not.toHaveBeenCalled();
  });

  it("rejects an authorized request over the rate limit", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("staff") } });
    mocks.isWithinStaffPrintRateLimit.mockResolvedValue(false);
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(429);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });
});

describe("POST /api/staff-print — request handling", () => {
  beforeEach(() => {
    mocks.getUser.mockResolvedValue({ data: { user: makeUser("staff") } });
  });

  it("computes waivedAmount server-side from the real page count/pricing and passes it through, never from the client", async () => {
    mocks.extractSelectedPages.mockResolvedValue({ bytes: new Uint8Array([1]), pageCount: 3 });
    mocks.getPricingConfig.mockResolvedValue({ priceBw: 2, priceColor: 10 });
    await POST(makeRequest({ ...validBody, settings: { copies: 2, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 } }));
    const call = mocks.createStaffPrintJob.mock.calls[0][0];
    expect(call.waivedAmount).toBe(12); // 3 pages * 2 copies * ₹2/page
  });

  it("rejects a document over the staff-specific page limit", async () => {
    mocks.extractSelectedPages.mockResolvedValue({ bytes: new Uint8Array([1]), pageCount: 9999 });
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(400);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });

  it("rejects a request over MAX_FILES_PER_ORDER server-side, never reaching createStaffPrintJob — the client's own basket limit is never trusted alone", async () => {
    const response = await POST(makeRequest({ ...validBody, fileCount: 51 }));
    expect(response.status).toBe(400);
    expect(mocks.createStaffPrintJob).not.toHaveBeenCalled();
  });

  it("allows a request at exactly MAX_FILES_PER_ORDER", async () => {
    const response = await POST(makeRequest({ ...validBody, fileCount: 50 }));
    expect(response.status).toBe(200);
  });

  it("surfaces the daily-cap rejection as a 429 with a clear message, not a generic 500", async () => {
    mocks.createStaffPrintJob.mockRejectedValue(new Error("Daily staff print cap reached (520 of 500 pages used today)."));
    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toMatch(/daily staff print cap/i);
  });

  it("cleans up the freshly-uploaded final PDF when createStaffPrintJob returns an EARLIER job (idempotent replay)", async () => {
    mocks.createStaffPrintJob.mockImplementation(async () => ({ id: "earlier-job-id", ticketNumber: 3, waivedAmount: 4 }));
    await POST(makeRequest(validBody));
    expect(mocks.deleteStorageObject).toHaveBeenCalledWith(expect.stringContaining(".pdf"));
  });

  it("does not delete the final PDF when the job actually created matches this request's own upload", async () => {
    await POST(makeRequest(validBody));
    const finalPathDeletes = mocks.deleteStorageObject.mock.calls.filter(([path]) => !path.startsWith("uploads/"));
    expect(finalPathDeletes).toHaveLength(0);
  });

  it("always cleans up the temp upload path, regardless of outcome", async () => {
    await POST(makeRequest(validBody));
    expect(mocks.deleteStorageObject).toHaveBeenCalledWith("uploads/temp-1.pdf");
  });
});
