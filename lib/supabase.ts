import { createBrowserClient } from "@supabase/ssr";

/**
 * Anon-key client for the admin panel's browser-side code — every query
 * made with this client carries the signed-in user's session, so Postgres
 * RLS (see SUPABASE_SETUP.md's admin-panel section) is the thing actually
 * deciding what comes back, not this file. NEVER import lib/supabase-admin.ts
 * (the service-role client) into a "use client" component — that key
 * bypasses RLS entirely.
 */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not configured.");
  }
  return createBrowserClient(url, anonKey);
}
