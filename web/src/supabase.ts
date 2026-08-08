import { createClient } from '@supabase/supabase-js';

// Browser client — the anon key is safe here (RLS + the backend's auth gate protect data).
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) console.warn('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in web/.env');

export const supabase = createClient(url ?? '', anon ?? '');
