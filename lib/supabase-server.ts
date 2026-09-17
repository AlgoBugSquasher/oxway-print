import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Anon-key client for Server Components / Route Handlers — reads the
 * session from the request's cookies (set by middleware.ts after sign-in),
 * so server-rendered admin pages see the same RLS-scoped view a client
 * component would. Still the anon key, still RLS-governed — this is not a
 * privileged client, just a server-side way to read the same session.
 */
export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured.");
  }

  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, which can't set cookies — safe to
          // ignore since middleware.ts already refreshes the session on every
          // request that matters.
        }
      },
    },
  });
}
