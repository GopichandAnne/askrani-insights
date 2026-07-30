import { NextResponse, after } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createWorkspaceFromCandidate, autoDiscoverCompetitors } from "@/lib/discovery";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { candidate, vertical: rawVertical } = await req.json().catch(() => ({}));
  if (!candidate?.name) return badRequest("candidate.name required");
  const vertical = rawVertical === "grocery" ? "grocery" : "restaurant";

  try {
    const ws = await createWorkspaceFromCandidate(auth.orgId, candidate, vertical);
    const competitors = await autoDiscoverCompetitors(
      ws.workspaceId,
      { businessId: ws.businessId, name: candidate.name, geo: ws.geo, category: candidate.category },
      { radiusKm: 3, limit: 12, vertical },
    );

    // Kick off background collection for the target + competitors immediately.
    const enqueued = await enqueueWorkspaceCollection(ws.workspaceId);
    // Nudge the worker so collection starts within seconds (not next cron tick).
    after(() => nudgeWorker());

    return NextResponse.json({
      workspaceId: ws.workspaceId,
      target: { businessId: ws.businessId, name: candidate.name, website: candidate.website, geo: ws.geo },
      competitors,
      enqueued,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
