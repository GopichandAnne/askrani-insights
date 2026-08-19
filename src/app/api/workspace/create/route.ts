import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createWorkspaceFromCandidate, autoDiscoverCompetitors } from "@/lib/discovery";
import { inferVertical, isVertical } from "@/lib/classify";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { candidate, vertical: rawVertical } = await req.json().catch(() => ({}));
  if (!candidate?.name) return badRequest("candidate.name required");
  // Honor the vertical DETECTION already classified (the client sends it as
  // cand.detectedVertical, from the intelligent detect) for ANY valid vertical;
  // only fall back to the deterministic classifier if it's missing/invalid.
  const vertical = isVertical(rawVertical) ? rawVertical : inferVertical(candidate);

  try {
    const ws = await createWorkspaceFromCandidate(auth.orgId, candidate, vertical);
    // Fresh competitor set each call (so a vertical override re-discovers cleanly
    // for the chosen type). No-op on first creation.
    await createServiceClient().from("competitor_edge").delete().eq("workspace_id", ws.workspaceId);
    const competitors = await autoDiscoverCompetitors(
      ws.workspaceId,
      { businessId: ws.businessId, name: candidate.name, geo: ws.geo, category: candidate.category, subtype: ws.subtype },
      { radiusKm: 6, limit: 12, vertical },
    );

    void logEvent("workspace_created", { vertical, competitors: competitors.length }, { orgId: auth.orgId, path: "/onboarding" });
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
