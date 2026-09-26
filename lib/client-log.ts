/**
 * Best-effort client -> server error reporting for the upload flow. Added
 * specifically to debug the iPhone 15/15 Plus Safari PDF-upload failures
 * that can't be reproduced on desktop — `console.error` alone is only
 * visible over a physical Safari Web Inspector session (Mac + cable +
 * Develop menu), which isn't realistic to get from an affected customer.
 * This instead lands the same information in the server's own logs (visible
 * in the Vercel dashboard, no device access needed), alongside the on-screen
 * error message the customer already sees via PdfPageSelector's error state.
 *
 * Never throws and never blocks the caller — a failed report must not turn
 * into a second, unrelated failure on top of whatever it's reporting.
 */
export function reportClientError(stage: string, error: unknown, meta?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[${stage}]`, error, meta);

  try {
    const payload = JSON.stringify({
      stage,
      message,
      stack,
      meta,
      userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      url: typeof window === "undefined" ? undefined : window.location.href,
    });
    void fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // Best-effort — nothing else to do if the report itself can't reach the server.
    });
  } catch {
    // JSON.stringify can throw on a pathological `meta` value — never let the
    // diagnostic path itself become the failure.
  }
}
