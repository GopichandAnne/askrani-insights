import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * URL for SERVER-side Supabase calls. Prefer SUPABASE_INTERNAL_URL (the direct
 * *.supabase.co host) so server queries skip the custom-domain Cloudflare hop
 * (~40ms/call × several calls per navigation). The browser still uses the custom
 * domain (NEXT_PUBLIC_SUPABASE_URL). Falls back to the public URL when unset, so
 * this is a no-op until the env is added.
 */
const serverUrl = () => process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;

/**
 * Server Supabase client (anon key + user session via cookies, RLS-enforced).
 * Use in server components / route handlers acting on behalf of a signed-in user.
 */
/** The request-scoped RLS client type. Reused as an optional override param on
 *  read helpers so the collection worker can pass a service-role client to run
 *  outside a request (see lib/warm.ts) while keeping full query typing. */
export type RlsClient = Awaited<ReturnType<typeof createClient>>;

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    serverUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[],
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // called from a Server Component — safe to ignore, middleware refreshes
          }
        },
      },
    },
  );
}

/**
 * Service-role client (BYPASSES RLS). Server-only. Use exclusively in
 * ingestion/extraction workers that must write cross-tenant public
 * observations. Never import into client or user-request code paths.
 */
export function createServiceClient() {
  const { createClient: createRaw } = require("@supabase/supabase-js");
  return createRaw(
    serverUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
