import { NextResponse } from "next/server";

/**
 * Vercel sends `Cache-Control: public, max-age=0, must-revalidate` by
 * default for Next.js Route Handlers — even ones marked
 * `export const dynamic = "force-dynamic"`, since that config only controls
 * server-side rendering behavior, not the actual response header. `public`
 * there explicitly permits the CDN to cache/coalesce responses, which is
 * exactly wrong for an endpoint a client polls every few seconds expecting
 * always-fresh data. Confirmed directly against the live deployment
 * (curl against oxway-print.vercel.app) that this was the cause of the
 * kiosk display occasionally showing a job as "printed" before it actually
 * was — the response the kiosk's poll received was a stale edge-cached
 * copy, not a fresh read of the database.
 *
 * Use this instead of NextResponse.json directly for any route a client
 * polls expecting live data — the success path AND every error path, since
 * Vercel's default applies to both alike.
 */
export function jsonNoStore<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store, must-revalidate" },
  });
}
