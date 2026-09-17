import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCashfreeWebhookSignature } from "./cashfree";
import { verifyRazorpayWebhookSignature } from "./razorpay";

// Highest-risk logic per ROADMAP.md #14: a broken signature check either
// lets a forged "payment succeeded" webhook through (prints for free) or
// rejects every real one (nothing ever gets marked paid via webhook). Pure
// functions, no Supabase/network involved, so no mocking needed.

describe("verifyCashfreeWebhookSignature", () => {
  const secret = "test-cashfree-secret";
  afterEach(() => {
    delete process.env.CASHFREE_WEBHOOK_SECRET;
    delete process.env.CASHFREE_SECRET_KEY;
  });

  it("accepts a correctly signed body", () => {
    process.env.CASHFREE_WEBHOOK_SECRET = secret;
    const rawBody = '{"order_id":"abc123","order_status":"PAID"}';
    const timestamp = "1700000000";
    const signature = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
    expect(verifyCashfreeWebhookSignature(rawBody, signature, timestamp)).toBe(true);
  });

  it("rejects a tampered body even with a validly-formed signature for different content", () => {
    process.env.CASHFREE_WEBHOOK_SECRET = secret;
    const timestamp = "1700000000";
    const signature = crypto.createHmac("sha256", secret).update(timestamp + '{"order_status":"PAID"}').digest("base64");
    expect(verifyCashfreeWebhookSignature('{"order_status":"FAILED"}', signature, timestamp)).toBe(false);
  });

  it("rejects a signature signed with the wrong secret", () => {
    process.env.CASHFREE_WEBHOOK_SECRET = secret;
    const rawBody = '{"order_status":"PAID"}';
    const timestamp = "1700000000";
    const forgedSignature = crypto.createHmac("sha256", "wrong-secret").update(timestamp + rawBody).digest("base64");
    expect(verifyCashfreeWebhookSignature(rawBody, forgedSignature, timestamp)).toBe(false);
  });

  it("falls back to CASHFREE_SECRET_KEY when CASHFREE_WEBHOOK_SECRET is unset", () => {
    process.env.CASHFREE_SECRET_KEY = secret;
    const rawBody = "{}";
    const timestamp = "1";
    const signature = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
    expect(verifyCashfreeWebhookSignature(rawBody, signature, timestamp)).toBe(true);
  });

  it("returns false (not throw) when no secret is configured at all", () => {
    expect(verifyCashfreeWebhookSignature("{}", "anything", "1")).toBe(false);
  });

  it("returns false (not throw) for a garbage/wrong-length signature", () => {
    process.env.CASHFREE_WEBHOOK_SECRET = secret;
    expect(verifyCashfreeWebhookSignature("{}", "not-even-base64-shaped!!", "1")).toBe(false);
  });
});

describe("verifyRazorpayWebhookSignature", () => {
  const secret = "test-razorpay-secret";
  afterEach(() => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it("accepts a correctly signed body", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    const rawBody = '{"event":"payment.captured"}';
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyRazorpayWebhookSignature(rawBody, signature)).toBe(true);
  });

  it("rejects a forged signature", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    const rawBody = '{"event":"payment.captured"}';
    const forgedSignature = crypto.createHmac("sha256", "wrong-secret").update(rawBody).digest("hex");
    expect(verifyRazorpayWebhookSignature(rawBody, forgedSignature)).toBe(false);
  });

  it("returns false (not throw) when no secret is configured", () => {
    expect(verifyRazorpayWebhookSignature("{}", "anything")).toBe(false);
  });

  it("returns false (not throw) for a garbage/wrong-length signature", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    expect(verifyRazorpayWebhookSignature("{}", "zz")).toBe(false);
  });
});
