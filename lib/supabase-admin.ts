import { createClient } from "@supabase/supabase-js";

/**
 * Used by API routes and the Pi's print agent — both trusted server-side
 * contexts. NEVER import this into a client component ("use client" file) —
 * the service role key bypasses Row Level Security entirely.
 *
 * lib/supabase.ts (the anon-key client) is still what the browser-facing
 * admin dashboard should use for read-only display.
 */
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured. See SUPABASE_SETUP.md."
    );
  }
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

let cached: ReturnType<typeof createAdminClient> | null = null;

/** Lazily constructed so a missing env var only throws when actually used, not at import/build time. */
export function supabaseAdmin() {
  if (!cached) cached = createAdminClient();
  return cached;
}
