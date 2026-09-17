import { supabaseAdmin } from "./supabase-admin";
import { CREATE_ORDER_RATE_LIMIT_MAX, CREATE_ORDER_RATE_LIMIT_WINDOW_SECONDS } from "./config";

/**
 * Basic abuse protection for /api/create-order (ROADMAP.md #13) — an
 * IP-keyed fixed-window counter. The increment itself happens inside a
 * single atomic Postgres statement (the increment_rate_limit function, see
 * SUPABASE_SETUP.md) rather than a read-then-write here, so two
 * near-simultaneous requests from the same IP can't both read the same
 * stale count and both slip through.
 *
 * Returns true if the request is allowed, false if the IP is over the limit.
 */
export async function isWithinCreateOrderRateLimit(ip: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("increment_rate_limit", {
    p_ip: ip,
    p_window_seconds: CREATE_ORDER_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (error) {
    // Fail open — a rate-limiter outage should never block real customers
    // from printing. This is abuse-mitigation, not a security boundary.
    console.error("Rate limit check failed, allowing the request:", error.message);
    return true;
  }
  return (data as number) <= CREATE_ORDER_RATE_LIMIT_MAX;
}

/** Vercel (and most reverse proxies) set this; take the first hop, which is the actual client. Falls back for local dev, where it's absent. */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return "unknown";
}
