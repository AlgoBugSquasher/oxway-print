import type { ErrorArea } from "./error-areas";

/**
 * Client-side (browser) counterpart to lib/errors.ts's logError — for a
 * raw Postgres/Supabase error caught directly in a client component (an
 * admin page's own `supabase.from(...)`/`supabase.rpc(...)` call, never
 * routed through one of our own API routes). Can't import lib/errors.ts
 * directly: that file uses the service-role key, which must never reach
 * browser code. Instead this posts to /api/client-log, which logs the
 * error server-side (via lib/errors.ts) and hands back a reference code.
 *
 * Never throws — if the report itself can't reach the server, this still
 * returns a usable (unreferenced) friendly message rather than compounding
 * one failure with a second.
 */
export async function reportErrorAndGetMessage(area: ErrorArea, error: unknown, extra?: Record<string, unknown>): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  try {
    const response = await fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        area,
        message,
        stack,
        meta: extra,
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
        url: typeof window === "undefined" ? undefined : window.location.href,
      }),
    });
    const body = (await response.json()) as { referenceCode?: string };
    if (body.referenceCode) return `Something went wrong. Please try again. Ref: ${body.referenceCode}`;
  } catch {
    // Best-effort — see this function's own docstring.
  }
  return "Something went wrong. Please try again.";
}
