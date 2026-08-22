import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser, ensureOrgForUser, isServiceConfigured } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

/** Cookie remembering which organization (account) the user is acting in. Only
 *  matters once a user belongs to more than one org (i.e. they've been invited to
 *  a teammate's account); single-org users never set it and resolve as before. */
export const ACTIVE_ORG_COOKIE = "ar_active_org";

export type MemberRole = "owner" | "admin" | "member" | "analyst" | "viewer";
export interface Membership { orgId: string; role: MemberRole }

/** Every org the user belongs to, with their role. Service client (bypasses RLS —
 *  org_membership is self-only under RLS, and this is a trusted server read). */
export async function listMemberships(userId: string): Promise<Membership[]> {
  const svc = createServiceClient();
  const { data } = await svc
    .from("org_membership")
    .select("organization_id, role")
    .eq("user_id", userId);
  return (data ?? []).map((m: { organization_id: string; role: string }) => ({ orgId: m.organization_id, role: m.role as MemberRole }));
}

/**
 * Resolve the verified user and the org they're acting in for a mutating API
 * route. The active org is the pinned cookie IF the user is a member of it,
 * otherwise their first/bootstrapped org — so a single-org user (no cookie)
 * resolves exactly as before. Also returns the caller's role in that org.
 * Returns null when unauthenticated / unconfigured — routes turn that into a 401.
 */
export async function requireOrg(): Promise<{ userId: string; orgId: string; role: MemberRole } | null> {
  if (!isServiceConfigured()) return null;
  const user = await getUser();
  if (!user) return null;

  const memberships = await listMemberships(user.id);
  const pinned = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  let orgId: string | undefined;
  if (pinned && memberships.some((m) => m.orgId === pinned)) orgId = pinned;
  if (!orgId) orgId = await ensureOrgForUser(user.id, user.email); // bootstrap if none

  const role = memberships.find((m) => m.orgId === orgId)?.role ?? "owner";
  return { userId: user.id, orgId, role };
}

/** Confirm a workspace belongs to the caller's org (tenant check for service-role writes). */
export async function workspaceInOrg(workspaceId: string, orgId: string): Promise<boolean> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("organization_id").eq("id", workspaceId).maybeSingle();
  return data?.organization_id === orgId;
}

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const badRequest = (m: string) => NextResponse.json({ error: m }, { status: 400 });
