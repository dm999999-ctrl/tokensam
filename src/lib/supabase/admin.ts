import "server-only";

import { createClient } from "@supabase/supabase-js";

/** Create a privileged Supabase client for server-side jobs and route handlers. */
export function createSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl || !secretKey) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY in the server environment.",
    );
  }

  return createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
