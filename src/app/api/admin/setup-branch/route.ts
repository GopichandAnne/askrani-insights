import { NextResponse } from "next/server";
import { discoverCandidates } from "@/lib/providers/registry";
import { createWorkspaceFromCandidate, autoDiscoverCompetitors } from "@/lib/discovery";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";
import { inferVertical, isVertical } from "@/lib/classify";

/**
 * Operator tool: stand up a NEW branch/market from the backend — discover the
 * target business (Google Places), create its workspace, auto-discover its local
 * competitors, and enqueue collection. WORKER_SECRET only (needs the prod Google
 * key; not user-facing). Drives the same discovery.ts path the Explore deep-read
 * uses. POST { query, orgId, vertical?, near?, radiusKm?, limit? }.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  return !!worker && provided === worker;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const query = String(body.query ?? "").trim();
  const orgId = String(body.orgId ?? "").trim();
  if (!query || !orgId) return NextResponse.json({ error: "query and orgId required" }, { status: 400 });
  const near = body.near && typeof body.near.lat === "number" ? { lat: body.near.lat, lng: body.near.lng, radiusKm: body.near.radiusKm } : undefined;
  const radiusKm = Number(body.radiusKm) || 8;
  const limit = Number(body.limit) || 12;

  try {
    // 1) find the target business
    const cands = await discoverCandidates({ query, near, limit: 10 });
    if (!cands.length) return NextResponse.json({ error: "no candidates found for query", query }, { status: 404 });
    const brand = norm(query.replace(/\b(tx|texas|usa)\b/gi, "").split(",")[0]);
    const target = cands.find((c) => brand && norm(c.name).includes(norm(query.split(/[, ]/)[0]))) // first word (e.g. "Patel")
      ?? cands.find((c) => brand.includes(norm(c.name)) || norm(c.name).includes(brand))
      ?? cands[0];

    const vertical = isVertical(body.vertical) ? body.vertical : inferVertical(target as any);
    const ws = await createWorkspaceFromCandidate(orgId, target, vertical);

    // 2) auto-discover its local competitors (like-for-like, LLM-ranked)
    const competitors = await autoDiscoverCompetitors(
      ws.workspaceId,
      { businessId: ws.businessId, name: target.name, geo: ws.geo, category: (target as any).category, subtype: ws.subtype },
      { radiusKm, limit, vertical },
    );

    // 3) enqueue collection for target + competitors
    const enqueued = await enqueueWorkspaceCollection(ws.workspaceId, { force: true });
    void nudgeWorker();

    return NextResponse.json({
      workspaceId: ws.workspaceId,
      businessId: ws.businessId,
      target: { name: target.name, geo: ws.geo, vertical },
      competitorCount: competitors.length,
      competitors: competitors.map((c: any) => c.name ?? c.canonical_name ?? "?"),
      enqueued,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
