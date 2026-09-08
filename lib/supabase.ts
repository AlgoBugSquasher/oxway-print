import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iwokgbyrviwbswsygeg.supabase.co';

const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummyKeyForBuild';

export const supabase = createClient(
  supabaseUrl.startsWith('http')
    ? supabaseUrl
    : 'https://iwokgbyrviwbswsygeg.supabase.co',
  supabaseAnonKey
);
