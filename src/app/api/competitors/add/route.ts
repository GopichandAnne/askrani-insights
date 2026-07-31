import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { addCompetitor } from "@/lib/discovery";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { workspaceId, candidate } = await req.json().catch(() => ({}));
  if (!workspaceId || !candidate?.name) return badRequest("workspaceId and candidate.name required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  try {
    const svc = createServiceClient();
    const { data: ws } = await svc
      .from("workspace")
      .select("target_business_id,vertical")
      .eq("id", workspaceId)
      .single();
    let geo, category: string | undefined, subtype: string[] | undefined;
    if (ws?.target_business_id) {
      const { data: b } = await svc
        .from("business")
        .select("category,attributes")
        .eq("id", ws.target_business_id)
        .single();
      category = b?.category ?? undefined;
      subtype = (b?.attributes as any)?.subtype as string[] | undefined;
    }
    const competitor = await addCompetitor(
      workspaceId,
      { businessId: ws?.target_business_id, geo, category, subtype },
      candidate,
      ws?.vertical ?? "restaurant",
    );
    // NOTE: collection is NOT auto-started. The user starts it explicitly once
    // the competitor set is curated (POST /api/collect/start).
    return NextResponse.json({ competitor });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
