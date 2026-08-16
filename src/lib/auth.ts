import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { grantTrialIfNeeded } from "@/lib/credits";
import { logEvent } from "@/lib/analytics";

/** Platform super-admins (comma-separated emails in SUPERADMIN_EMAILS). */
export function isSuperAdmin(user: { email?: string | null } | null | undefined): boolean {
  if (!user?.email) return false;
  const list = (process.env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(user.email.toLowerCase());
}

export function isSupabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function isServiceConfigured(): boolean {
  return isSupabaseConfigured() && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

/** Current auth user, or null. Safe to call when Supabase is unconfigured.
 *
 *  Fast path: getClaims() verifies the JWT LOCALLY via the project's JWKS (the
 *  project uses asymmetric ES256 signing keys) — no round-trip to the auth server,
 *  which was the main per-navigation latency. The middleware still validates +
 *  refreshes the session over the network once per request, so this stays secure.
 *  Falls back to the network getUser() if a local verification isn't available.
 *
 *  Wrapped in React cache() so the layout, activeWorkspace() and the page share
 *  ONE resolution per request. */
export const getUser = cache(async (): Promise<AuthUser | null> => {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  try {
    const { data, error } = await supabase.auth.getClaims();
    const c = data?.claims as Record<string, any> | undefined;
    if (!error && c?.sub) {
      return {
        id: String(c.sub),
        email: (c.email ?? null) as string | null,
        phone: (c.phone ?? null) as string | null,
        user_metadata: (c.user_metadata ?? {}) as Record<string, unknown>,
        app_metadata: (c.app_metadata ?? {}) as Record<string, unknown>,
      };
    }
  } catch { /* fall through to the network check */ }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    phone: user.phone ?? null,
    user_metadata: (user.user_metadata ?? {}) as Record<string, unknown>,
    app_metadata: (user.app_metadata ?? {}) as Record<string, unknown>,
  };
});

/** Require a signed-in user; redirect to /login otherwise. */
export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Ensure the signed-in user belongs to an organization; create one on first
 * sign-in. Runs with the service-role client (bypasses RLS) — organization and
 * org_membership have no authenticated INSERT policy by design, so tenant
 * bootstrap is a trusted server operation keyed off the verified auth user.
 */
export const ensureOrgForUser = cache(async (userId: string, email?: string | null): Promise<string> => {
  const svc = createServiceClient();

  const { data: existing } = await svc
    .from("org_membership")
    .select("organization_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (existing?.organization_id) {
    const orgId = existing.organization_id as string;
    await grantTrialIfNeeded(orgId); // idempotent — backfills trial for existing orgs too
    return orgId;
  }

  const orgName = email ? `${email.split("@")[0]}'s workspace` : "My workspace";
  const { data: org, error: orgErr } = await svc
    .from("organization")
    .insert({ name: orgName })
    .select("id")
    .single();
  if (orgErr) throw new Error(`create org: ${orgErr.message}`);

  const { error: memErr } = await svc.from("org_membership").insert({
    organization_id: org.id,
    user_id: userId,
    role: "owner",
  });
  if (memErr) throw new Error(`create membership: ${memErr.message}`);

  await grantTrialIfNeeded(org.id as string);
  // First org for this user == a new signup (first authenticated action).
  void logEvent("signup", {}, { orgId: org.id as string });
  return org.id as string;
});
