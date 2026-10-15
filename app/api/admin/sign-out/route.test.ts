import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  logAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser, signOut: mocks.signOut } }),
}));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

import { POST } from "./route";

function makeRequest(): Request {
  return new Request("http://localhost/api/admin/sign-out", { method: "POST", headers: { "user-agent": "test-agent" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/sign-out", () => {
  it("signs out and logs sign_out for a real signed-in user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", app_metadata: { role: "staff" } } } });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "sign_out",
      actorUserId: "user-1",
      actorRole: "staff",
      ip: "1.2.3.4",
      userAgent: "test-agent",
    });
  });

  it("still signs out but logs nothing when there was no session to begin with", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
