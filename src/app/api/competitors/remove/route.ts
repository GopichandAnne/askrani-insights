import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Remove a competitor edge (verifies the edge's workspace is in the caller's org). */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { edgeId } = await req.json().catch(() => ({}));
  if (!edgeId) return badRequest("edgeId required");

  const svc = createServiceClient();
  const { data: edge } = await svc
    .from("competitor_edge")
    .select("id,workspace:workspace_id(organization_id)")
    .eq("id", edgeId)
    .maybeSingle();
  if (!edge || (edge.workspace as any)?.organization_id !== auth.orgId) return unauthorized();

  await svc.from("competitor_edge").delete().eq("id", edgeId);
  return NextResponse.json({ ok: true });
}
