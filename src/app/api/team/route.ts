import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { listTeam, addTeamMember, changeRole, removeMember, type TeamRole } from "@/lib/team";

export const dynamic = "force-dynamic";

/** Owner (or platform super-admin) of the ACTIVE org may manage its team. */
async function gate(): Promise<{ orgId: string } | null> {
  const auth = await requireOrg();
  if (!auth) return null;
  if (auth.role === "owner") return { orgId: auth.orgId };
  if (isSuperAdmin(await getUser())) return { orgId: auth.orgId };
  return null;
}

const asRole = (v: unknown): TeamRole | null => (v === "owner" || v === "member" ? v : null);

/** GET /api/team → the roster for the active org. */
export async function GET() {
  const g = await gate();
  if (!g) return unauthorized();
  return NextResponse.json({ members: await listTeam(g.orgId) });
}

/** POST /api/team { action: "add" | "role" | "remove", ... } */
export async function POST(req: Request) {
  const g = await gate();
  if (!g) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "add") {
    const role = asRole(body.role);
    if (!role) return badRequest("role must be owner or member");
    const origin = new URL(req.url).origin;
    const res = await addTeamMember(g.orgId, String(body.email ?? ""), role, origin, body.name ? String(body.name) : undefined);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }

  if (action === "role") {
    const role = asRole(body.role);
    if (!role) return badRequest("role must be owner or member");
    if (!body.userId) return badRequest("userId required");
    const res = await changeRole(g.orgId, String(body.userId), role);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }

  if (action === "remove") {
    if (!body.userId) return badRequest("userId required");
    const res = await removeMember(g.orgId, String(body.userId));
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }

  return badRequest("unknown action");
}
