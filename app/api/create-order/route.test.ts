import { describe, expect, it, vi } from "vitest";

// Goal: "nobody can pay while the kiosk is offline" — these cover the
// server-side gate in app/api/create-order/route.ts directly (the only
// place that actually creates a job + a gateway order), independent of the
// customer page's own UI mirror. Everything downstream of the gate is
// mocked to a harmless default; the "online" test only needs to prove
// execution reaches past the gate (downloadJobPdf), not that the entire
// rest of the pipeline succeeds — that happy path is exercised elsewhere.

const mock = vi.hoisted(() => ({
  isOnline: true,
  downloadJobPdfCalls: 0,
  createJobCalls: 0,
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "127.0.0.1",
  isWithinCreateOrderRateLimit: () => Promise.resolve(true),
}));

vi.mock("@/lib/kiosk-stats", () => ({
  getKioskWhatsappAvailability: () => Promise.resolve({ allowWhatsapp: false }),
  getKioskColorModes: () => Promise.resolve({ allowColor: true, allowBw: true }),
  getKioskUpdateState: () => Promise.resolve({ isUpdating: false }),
  getKioskPrintBlockedState: () => Promise.resolve({ printBlocked: false, printBlockedReason: null }),
  isKioskCurrentlyOnline: () => Promise.resolve(mock.isOnline),
}));

vi.mock("@/lib/store", () => ({
  downloadJobPdf: () => {
    mock.downloadJobPdfCalls += 1;
    // Sentinel — stops execution right after the gate under test, without
    // needing to mock the entire rest of the success path.
    return Promise.reject(new Error("STOPPED_AFTER_GATE"));
  },
  findRecentDuplicateJob: () => Promise.resolve(null),
  createJob: () => {
    mock.createJobCalls += 1;
    return Promise.resolve();
  },
  deleteStorageObject: () => Promise.resolve(),
  getPricingConfig: () => Promise.resolve({ priceBw: 2, priceColor: 10 }),
  assignTicketNumber: () => Promise.resolve({ ticketNumber: 1, ticketDate: "2026-10-19" }),
  updateJob: () => Promise.resolve(),
  uploadJobPdf: () => Promise.resolve("final.pdf"),
}));

vi.mock("@/lib/payment", () => ({
  createOrder: () => Promise.resolve({ provider: "razorpay", providerOrderId: "order_1", keyId: "key_1", amount: 100 }),
}));

function requestBody() {
  return {
    pdfStoragePath: "uploads/abc.pdf",
    fileName: "test.pdf",
    selectedPages: [1],
    settings: { copies: 1, layout: "portrait", isColor: false, paperSize: "A4", pagesPerSheet: 1 },
    totalPrice: 2,
    kioskId: "oxway_01",
  };
}

describe("POST /api/create-order — offline gate", () => {
  it("refuses with a clear error and creates nothing when the kiosk is offline", async () => {
    mock.isOnline = false;
    mock.downloadJobPdfCalls = 0;
    mock.createJobCalls = 0;
    const { POST } = await import("./route");

    const response = await POST(new Request("http://localhost/api/create-order", { method: "POST", body: JSON.stringify(requestBody()) }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("This kiosk is offline right now, so payment is turned off. Please try again in a few minutes.");
    expect(mock.downloadJobPdfCalls).toBe(0);
    expect(mock.createJobCalls).toBe(0);
  });

  it("does not refuse for being offline when the kiosk is online — execution reaches past the gate", async () => {
    mock.isOnline = true;
    mock.downloadJobPdfCalls = 0;
    mock.createJobCalls = 0;
    const { POST } = await import("./route");

    const response = await POST(new Request("http://localhost/api/create-order", { method: "POST", body: JSON.stringify(requestBody()) }));
    const body = await response.json();

    expect(body.error).not.toMatch(/offline/i);
    expect(mock.downloadJobPdfCalls).toBe(1);
  });
});
