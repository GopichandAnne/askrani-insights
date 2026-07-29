import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createWorkspaceFromCandidate, autoDiscoverCompetitors } from "@/lib/discovery";
import { enqueueWorkspaceCollection } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { candidate } = await req.json().catch(() => ({}));
  if (!candidate?.name) return badRequest("candidate.name required");

  try {
    const ws = await createWorkspaceFromCandidate(auth.orgId, candidate);
    const competitors = await autoDiscoverCompetitors(
      ws.workspaceId,
      { businessId: ws.businessId, name: candidate.name, geo: ws.geo, category: candidate.category },
      { radiusKm: 3, limit: 12 },
    );

    // Kick off background collection for the target + competitors immediately.
    const enqueued = await enqueueWorkspaceCollection(ws.workspaceId);

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
