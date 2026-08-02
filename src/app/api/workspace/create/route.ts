import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createWorkspaceFromCandidate, autoDiscoverCompetitors } from "@/lib/discovery";
import { inferVertical } from "@/lib/classify";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { candidate, vertical: rawVertical } = await req.json().catch(() => ({}));
  if (!candidate?.name) return badRequest("candidate.name required");
  // Auto-detect the vertical from the picked place's tags/name; honor an explicit
  // client override only when it's a valid value.
  const VALID = new Set(["grocery", "restaurant", "salon"]);
  const vertical = VALID.has(rawVertical) ? rawVertical : inferVertical(candidate);

  try {
    const ws = await createWorkspaceFromCandidate(auth.orgId, candidate, vertical);
    // Fresh competitor set each call (so a vertical override re-discovers cleanly
    // for the chosen type). No-op on first creation.
    await createServiceClient().from("competitor_edge").delete().eq("workspace_id", ws.workspaceId);
    const competitors = await autoDiscoverCompetitors(
      ws.workspaceId,
      { businessId: ws.businessId, name: candidate.name, geo: ws.geo, category: candidate.category, subtype: ws.subtype },
      { radiusKm: 3, limit: 12, vertical },
    );

    // NOTE: collection is NOT started here. The user reviews/edits the competitor
    // set first, then explicitly starts it (POST /api/collect/start).
    return NextResponse.json({
      workspaceId: ws.workspaceId,
      vertical,
      subtype: ws.subtype,
      collectionStarted: false, // gated: user starts collection explicitly
      target: { businessId: ws.businessId, name: candidate.name, website: candidate.website, geo: ws.geo },
      competitors,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
