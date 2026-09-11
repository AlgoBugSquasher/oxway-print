import { createClient } from '@supabase/supabase-js';

const fallbackUrl = 'https://iwokgbyrviwbswsygeg.supabase.co';
const fallbackKey = 'dummy-key-for-build';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || fallbackUrl;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || fallbackKey;

// Standard client with safe fallback
export const supabase = createClient(
  supabaseUrl.startsWith('http') ? supabaseUrl : fallbackUrl,
  supabaseAnonKey
);

// Lazy function for Admin client (Never crashes during build)
export function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || fallbackUrl;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || fallbackKey;

  return createClient(
    url.startsWith('http') ? url : fallbackUrl,
    serviceKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}