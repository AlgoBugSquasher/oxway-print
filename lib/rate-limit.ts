import { supabaseAdmin } from "./supabase-admin";
import { COLLECT_JOB_RATE_LIMIT_MAX, COLLECT_JOB_RATE_LIMIT_WINDOW_SECONDS, CREATE_ORDER_RATE_LIMIT_MAX, CREATE_ORDER_RATE_LIMIT_WINDOW_SECONDS, LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_SECONDS, STAFF_PRINT_RATE_LIMIT_MAX, STAFF_PRINT_RATE_LIMIT_WINDOW_SECONDS } from "./config";

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

/**
 * Same atomic counter as isWithinCreateOrderRateLimit above, keyed by the
 * signed-in staff/owner user's id instead of an IP — app/api/staff-print's
 * caller is always authenticated, so the user id is the more precise key
 * (one staff member on a shared kiosk network shouldn't get rate-limited by
 * another's activity, and an IP-based key would do exactly that here).
 * Reuses the same increment_rate_limit() RPC/table (its `p_ip` column is
 * really just "the key," not actually IP-specific) rather than standing up
 * a parallel table only for this.
 */
export async function isWithinStaffPrintRateLimit(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("increment_rate_limit", {
    p_ip: `staff:${userId}`,
    p_window_seconds: STAFF_PRINT_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (error) {
    console.error("Staff print rate limit check failed, allowing the request:", error.message);
    return true;
  }
  return (data as number) <= STAFF_PRINT_RATE_LIMIT_MAX;
}

/**
 * Basic abuse protection on login attempts (both /api/admin/login and the
 * prototype passcode route) — checked against BOTH the attempted email and
 * the caller's IP independently; the caller rejects if either comes back
 * over the limit. Same fail-open reasoning as the other two limiters above:
 * a rate-limiter outage should never lock every admin out.
 */
export async function isWithinLoginRateLimit(key: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("increment_rate_limit", {
    p_ip: `login:${key}`,
    p_window_seconds: LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (error) {
    console.error("Login rate limit check failed, allowing the request:", error.message);
    return true;
  }
  return (data as number) <= LOGIN_RATE_LIMIT_MAX;
}

export async function isWithinCollectJobRateLimit(key: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("increment_rate_limit", {
    p_ip: `collect:${key}`,
    p_window_seconds: COLLECT_JOB_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (error) {
    console.error("Collect-job rate limit check failed, allowing the request:", error.message);
    return true;
  }
  return (data as number) <= COLLECT_JOB_RATE_LIMIT_MAX;
}

/** Vercel (and most reverse proxies) set this; take the first hop, which is the actual client. Falls back for local dev, where it's absent. */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return "unknown";
}
