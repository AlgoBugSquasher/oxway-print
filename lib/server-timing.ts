/**
 * Minimal server-side timing — console.log only, no new dependency,
 * nothing persisted. Used on the admin login/navigation path (proxy.ts,
 * the dashboard layout, and the couple of API routes hit on first load) so
 * every step logs the same grep-friendly shape in Vercel's function logs
 * (or the local dev terminal): `[admin-timing] <label> <ms>ms key=value`.
 *
 * Split into two functions on purpose: `withTiming` is the only place that
 * ever calls Date.now() (an impure, non-deterministic read) — isolating it
 * here means a Server Component calling this, like
 * app/admin/(dashboard)/layout.tsx, never calls an impure function
 * directly in its own render body itself. `logDuration` just formats and
 * prints an already-known number.
 */
export async function withTiming<T>(fn: () => Promise<T>): Promise<{ result: T; tookMs: number }> {
  const startedAtMs = Date.now();
  const result = await fn();
  return { result, tookMs: Date.now() - startedAtMs };
}

export function logDuration(label: string, tookMs: number, extra?: Record<string, string | number | boolean>): void {
  const extraText = extra ? ` ${Object.entries(extra).map(([key, value]) => `${key}=${value}`).join(" ")}` : "";
  console.log(`[admin-timing] ${label} ${tookMs}ms${extraText}`);
}
