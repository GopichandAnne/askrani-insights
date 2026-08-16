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

/** Current auth user, or null. Safe to call when Supabase is unconfigured.
 *  Wrapped in React cache() so the layout, activeWorkspace() and the page all
 *  share ONE auth validation per request instead of each doing its own network
 *  round-trip to the Supabase auth server (the main navigation-latency cause). */
export const getUser = cache(async () => {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
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
export async function ensureOrgForUser(userId: string, email?: string | null): Promise<string> {
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
}
