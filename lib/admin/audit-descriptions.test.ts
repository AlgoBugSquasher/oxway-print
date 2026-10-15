import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, describeAuditAction, hasBeforeAfter, summarizeAuditEntry } from "./audit-descriptions";
import type { AuditLogRow } from "./types";

function makeEntry(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: 1,
    at: new Date().toISOString(),
    actor_user_id: "user-1",
    actor_role: "owner",
    kiosk_id: null,
    action: "login_success",
    target_type: null,
    target_id: null,
    details: null,
    ip: "1.2.3.4",
    user_agent: "test",
    ...overrides,
  };
}

describe("describeAuditAction", () => {
  it("maps a known action to its human label", () => {
    expect(describeAuditAction("pricing_updated")).toBe("Pricing changed");
  });

  it("falls back to the raw action string for an unknown/future action — never throws", () => {
    expect(describeAuditAction("some_new_feature_action")).toBe("some_new_feature_action");
  });

  it("lists every known action for the filter dropdown", () => {
    expect(AUDIT_ACTIONS).toContain("login_success");
    expect(AUDIT_ACTIONS).toContain("job_refunded");
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(5);
  });
});

describe("summarizeAuditEntry", () => {
  it("includes the masked email attempted on a failed login", () => {
    const entry = makeEntry({ action: "login_failed", actor_user_id: null, details: { emailAttempted: "o***(5)@example.com" } });
    expect(summarizeAuditEntry(entry)).toBe("Sign-in failed (o***(5)@example.com)");
  });

  it("includes the new prices on a pricing change", () => {
    const entry = makeEntry({ action: "pricing_updated", details: { before: { price_bw: 2, price_color: 10 }, after: { price_bw: 3, price_color: 12 } } });
    expect(summarizeAuditEntry(entry)).toBe("Pricing changed: B&W ₹3, Color ₹12");
  });

  it("includes a shortened job id on a cancellation", () => {
    const entry = makeEntry({ action: "job_cancelled", target_type: "print_job", target_id: "11111111-2222-3333-4444-555555555555" });
    expect(summarizeAuditEntry(entry)).toBe("Job cancelled (job 11111111)");
  });

  it("includes the page count on a staff print", () => {
    const entry = makeEntry({ action: "staff_print_created", details: { file_name: "f.pdf", pages: 3, waived_amount: 6 } });
    expect(summarizeAuditEntry(entry)).toBe("Free staff print created: 3 pages");
  });

  it("includes the command and status on a finished kiosk command", () => {
    const entry = makeEntry({ action: "kiosk_command_finished", details: { command: "restart", status: "failed", result: "Agent offline." } });
    expect(summarizeAuditEntry(entry)).toBe("Kiosk command finished: restart — failed");
  });

  it("falls back to the plain label when details are missing entirely", () => {
    const entry = makeEntry({ action: "sign_out", details: null });
    expect(summarizeAuditEntry(entry)).toBe("Signed out");
  });
});

describe("hasBeforeAfter", () => {
  it("is true for the {before, after} shape every toggle/setting action writes", () => {
    expect(hasBeforeAfter({ before: { a: 1 }, after: { a: 2 } })).toBe(true);
  });

  it("is false for a flat details object (e.g. staff_print_created)", () => {
    expect(hasBeforeAfter({ pages: 3, waived_amount: 6 })).toBe(false);
  });

  it("is false for null details", () => {
    expect(hasBeforeAfter(null)).toBe(false);
  });
});
