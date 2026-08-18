"use client";

import { createBrowserClient } from "@supabase/ssr";
import { authCookieName } from "./cookie-name";

/**
 * Browser Supabase client (anon key, RLS-enforced).
 * Only ever sees data the current member is authorized to read.
 */
export function createClient() {
  const name = authCookieName();
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    name ? { cookieOptions: { name } } : undefined,
  );
}
