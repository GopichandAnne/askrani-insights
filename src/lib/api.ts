import { NextResponse } from "next/server";
import { getUser, ensureOrgForUser, isServiceConfigured } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Resolve the verified user and their org for a mutating API route. Returns null
 * when unauthenticated / unconfigured — routes turn that into a 401.
 */
export async function requireOrg(): Promise<{ userId: string; orgId: string } | null> {
  if (!isServiceConfigured()) return null;
  const user = await getUser();
  if (!user) return null;
  const orgId = await ensureOrgForUser(user.id, user.email);
  return { userId: user.id, orgId };
}

/** Confirm a workspace belongs to the caller's org (tenant check for service-role writes). */
export async function workspaceInOrg(workspaceId: string, orgId: string): Promise<boolean> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("organization_id").eq("id", workspaceId).maybeSingle();
  return data?.organization_id === orgId;
}

export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
export const badRequest = (m: string) => NextResponse.json({ error: m }, { status: 400 });
