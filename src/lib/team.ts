import { createServiceClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";

/**
 * Team management — mirrors the Rani app's staff/team mechanism, on Insights'
 * existing org_membership table. Two effective roles: "owner" (full control incl.
 * managing the team + billing) and "member" (operate, no team/billing management).
 *
 * Invite = direct add by email (no pending-invite table, like Rani): look the
 * email up in auth; if the account is missing, send a Supabase magic-link invite;
 * then upsert the membership row. All writes go through the service-role client;
 * authorization is enforced by the caller (route uses requireOrg → role "owner").
 */

export type TeamRole = "owner" | "member";
export interface TeamMember {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  isSelf: boolean;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Auth users are keyed by id; resolve email/name from the admin API. */
async function resolveUser(svc: ReturnType<typeof createServiceClient>, userId: string): Promise<{ email: string | null; name: string | null }> {
  try {
    const { data } = await (svc as any).auth.admin.getUserById(userId);
    const u = data?.user;
    return { email: u?.email ?? null, name: (u?.user_metadata?.full_name as string) ?? null };
  } catch {
    return { email: null, name: null };
  }
}

/** Everyone in an org, owners first, emails resolved. */
export async function listTeam(orgId: string): Promise<TeamMember[]> {
  const svc = createServiceClient();
  const me = await getUser();
  // name comes from the auth user's metadata (no column dependency, so the feature
  // works with or without migration 0072 applied).
  const { data: rows } = await svc
    .from("org_membership")
    .select("user_id, role")
    .eq("organization_id", orgId);
  const out: TeamMember[] = [];
  for (const r of rows ?? []) {
    const u = await resolveUser(svc, r.user_id as string);
    out.push({
      userId: r.user_id as string,
      email: u.email,
      name: u.name,
      role: r.role as string,
      isSelf: me?.id === r.user_id,
    });
  }
  out.sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || (a.email ?? "").localeCompare(b.email ?? ""));
  return out;
}

/** user_ids that are owners of the org — used to protect the last owner. */
async function ownerIds(svc: ReturnType<typeof createServiceClient>, orgId: string): Promise<string[]> {
  const { data } = await svc.from("org_membership").select("user_id").eq("organization_id", orgId).eq("role", "owner");
  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

/** Find an existing auth user by email (admin API has no email filter — page). */
async function findUserByEmail(svc: ReturnType<typeof createServiceClient>, email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    try {
      const { data } = await (svc as any).auth.admin.listUsers({ page, perPage: 200 });
      const hit = (data?.users ?? []).find((u: { email?: string }) => (u.email ?? "").toLowerCase() === email);
      if (hit) return hit.id as string;
      if (!data?.users || data.users.length < 200) break; // last page
    } catch {
      break;
    }
  }
  return null;
}

/** Add (or update) a team member by email. `origin` is the invite link's base. */
export async function addTeamMember(
  orgId: string, email: string, role: TeamRole, origin: string, name?: string,
): Promise<{ ok: true; invited: boolean } | { ok: false; error: string }> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { ok: false, error: "Enter a valid email address." };
  const svc = createServiceClient();

  let userId = await findUserByEmail(svc, clean);
  let invited = false;
  if (!userId) {
    try {
      const { data, error } = await (svc as any).auth.admin.inviteUserByEmail(clean, {
        data: name ? { full_name: name } : {},
        redirectTo: `${origin}/auth/callback?next=/`,
      });
      if (error || !data?.user) return { ok: false, error: "Couldn't send the invite — check the email and try again." };
      userId = data.user.id as string;
      invited = true;
    } catch {
      return { ok: false, error: "Couldn't send the invite — check the email and try again." };
    }
  }

  const { error } = await svc
    .from("org_membership")
    .upsert({ organization_id: orgId, user_id: userId, role }, { onConflict: "organization_id,user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, invited };
}

export async function changeRole(orgId: string, userId: string, role: TeamRole): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient();
  if (role !== "owner") {
    const owners = await ownerIds(svc, orgId);
    if (owners.length <= 1 && owners.includes(userId)) return { ok: false, error: "You can't demote the last owner — make someone else an owner first." };
  }
  const { error } = await svc.from("org_membership").update({ role }).eq("organization_id", orgId).eq("user_id", userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function removeMember(orgId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient();
  const owners = await ownerIds(svc, orgId);
  if (owners.length <= 1 && owners.includes(userId)) return { ok: false, error: "You can't remove the last owner." };
  const { error } = await svc.from("org_membership").delete().eq("organization_id", orgId).eq("user_id", userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
