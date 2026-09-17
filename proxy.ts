import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Server-side gate for every /admin/* route (login excluded) — refuses to
 * render the page at all without a valid session, rather than relying on a
 * client-side redirect after the page has already started loading. This is
 * the only proxy (Next.js 16's renamed middleware convention) in this
 * project; scoped tightly via `config.matcher` below so it doesn't touch
 * the customer-facing upload flow or the API routes at all.
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

  // getUser() (not getSession()) — it revalidates against Supabase Auth
  // itself rather than trusting the cookie's own claims, which matters for
  // a check that's actually gating access.
  const { data: { user } } = await supabase.auth.getUser();

  if (!user && !request.nextUrl.pathname.startsWith("/admin/login")) {
    const loginUrl = new URL("/admin/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (user && request.nextUrl.pathname.startsWith("/admin/login")) {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
