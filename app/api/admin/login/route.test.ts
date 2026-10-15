import { beforeEach, describe, expect, it, vi } from "vitest";

// The real server-side checkpoint this route exists to add — see its own
// docstring. Three things must hold regardless of how signInWithPassword
// resolves: a generic error message (never Supabase's own wording, and
// identical for "wrong password" and "unknown account" — account-hardening
// requirement #1's "don't reveal whether an account exists"), an audit
// entry for both success and failure, and the rate limit checked BEFORE
// ever calling Supabase at all.

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- parameter typed so mockImplementation(key => ...) below is `string`, not `unknown`
  isWithinLoginRateLimit: vi.fn(async (_key: string) => true),
  logAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/supabase-server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signInWithPassword: mocks.signInWithPassword } }),
}));
vi.mock("@/lib/rate-limit", () => ({
  isWithinLoginRateLimit: mocks.isWithinLoginRateLimit,
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
  maskEmail: (email: string) => `masked(${email})`,
}));

import { POST } from "./route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "test-agent" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWithinLoginRateLimit.mockResolvedValue(true);
});

describe("POST /api/admin/login", () => {
  it("signs in and logs login_success on a correct password", async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: { user: { id: "user-1", app_metadata: { role: "owner" } } }, error: null });

    const response = await POST(makeRequest({ email: "owner@example.com", password: "correct" }));

    expect(response.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "login_success",
      actorUserId: "user-1",
      actorRole: "owner",
      ip: "1.2.3.4",
      userAgent: "test-agent",
    });
  });

  it("returns the exact same generic error for a wrong password as for an unknown account — never reveals which", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });
    const wrongPasswordResponse = await POST(makeRequest({ email: "owner@example.com", password: "wrong" }));
    const wrongPasswordBody = await wrongPasswordResponse.json();

    mocks.signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });
    const unknownAccountResponse = await POST(makeRequest({ email: "nobody@example.com", password: "whatever" }));
    const unknownAccountBody = await unknownAccountResponse.json();

    expect(wrongPasswordResponse.status).toBe(401);
    expect(unknownAccountResponse.status).toBe(401);
    expect(wrongPasswordBody.error).toBe(unknownAccountBody.error);
    expect(wrongPasswordBody.error.toLowerCase()).not.toContain("exist");
  });

  it("logs login_failed (with the attempted email masked, never raw) on a failed sign-in", async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: { user: null }, error: { message: "Invalid login credentials" } });

    await POST(makeRequest({ email: "owner@example.com", password: "wrong" }));

    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "login_failed",
      details: { emailAttempted: "masked(owner@example.com)" },
      ip: "1.2.3.4",
      userAgent: "test-agent",
    });
  });

  it("checks the rate limit BEFORE ever calling signInWithPassword", async () => {
    mocks.isWithinLoginRateLimit.mockResolvedValue(false);

    const response = await POST(makeRequest({ email: "owner@example.com", password: "whatever" }));

    expect(response.status).toBe(429);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("checks both the per-email AND per-IP rate limit, rejecting if either is over", async () => {
    mocks.isWithinLoginRateLimit.mockImplementation(async (key: string) => key !== "1.2.3.4");

    const response = await POST(makeRequest({ email: "owner@example.com", password: "whatever" }));

    expect(response.status).toBe(429);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("rejects a request missing email or password with 400, never reaching sign-in or the rate limiter", async () => {
    const response = await POST(makeRequest({ email: "owner@example.com" }));
    expect(response.status).toBe(400);
    expect(mocks.isWithinLoginRateLimit).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });
});
