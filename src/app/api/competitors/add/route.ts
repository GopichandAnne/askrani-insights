import { NextResponse, after } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { addCompetitor } from "@/lib/discovery";
import { enqueueOne, nudgeWorker } from "@/lib/jobs";
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
      .select("target_business_id")
      .eq("id", workspaceId)
      .single();
    let geo, category: string | undefined;
    if (ws?.target_business_id) {
      const { data: loc } = await svc
        .from("location")
        .select("geo")
        .eq("business_id", ws.target_business_id)
        .limit(1)
        .maybeSingle();
      // geo comes back as GeoJSON-ish or WKB; we only need category for scoring here
      void loc;
      const { data: b } = await svc.from("business").select("category").eq("id", ws.target_business_id).single();
      category = b?.category ?? undefined;
    }
    const competitor = await addCompetitor(
      workspaceId,
      { businessId: ws?.target_business_id, geo, category },
      candidate,
    );
    // queue the new competitor for background collection + kick the worker
    await enqueueOne(svc, workspaceId, competitor.businessId, 0);
    after(() => nudgeWorker());
    return NextResponse.json({ competitor });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
