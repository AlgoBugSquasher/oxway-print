import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { logDuration, withTiming } from "@/lib/server-timing";

/**
 * Server-side gate for every /admin/* route (login excluded) — refuses to
 * render the page at all without a valid session, rather than relying on a
 * client-side redirect after the page has already started loading. This is
 * the only proxy (Next.js 16's renamed middleware convention) in this
 * project; scoped tightly via `config.matcher` below so it doesn't touch
 * the customer-facing upload flow or the API routes at all.
 *
 * getClaims() (not getUser()) — this still cryptographically verifies the
 * access token before trusting it (never a bare decode), it just verifies
 * the signature locally against the project's cached JWKS instead of
 * making a network round trip to the Auth server on every single
 * navigation, which is what getUser() always does. This project's JWT
 * signing keys are already asymmetric (ES256 — confirmed via its own
 * /auth/v1/.well-known/jwks.json), so this is a real, local verification,
 * not a weaker check: if the project ever reverted to a symmetric secret,
 * getClaims() itself falls back to calling the Auth server exactly like
 * getUser() did, so this can never silently become less safe than before.
 * Full getUser()-against-the-server verification is kept everywhere an
 * actual write happens (the RPCs' own current_app_role() check, and the
 * /api/admin/* routes) — this is only the "is there a session at all" gate.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured.");
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { result: { data, error }, tookMs } = await withTiming(() => supabase.auth.getClaims());
  const hasValidSession = !error && data !== null;
  logDuration("proxy.getClaims", tookMs, { path: request.nextUrl.pathname, hasValidSession });

  if (!hasValidSession && !request.nextUrl.pathname.startsWith("/admin/login")) {
    const loginUrl = new URL("/admin/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (hasValidSession && request.nextUrl.pathname.startsWith("/admin/login")) {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
