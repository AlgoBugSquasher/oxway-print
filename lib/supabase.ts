import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iwokgbyrviwbswsygeg.supabase.co';

const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key_for_build';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
