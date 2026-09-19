import { NextResponse } from "next/server";
import { discoverCandidates } from "@/lib/providers/registry";
import { addCompetitor } from "@/lib/discovery";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Operator tool: add competitor(s) to a workspace by SEARCH QUERY — discovers the
 * business (Google Places) and attaches it. WORKER_SECRET only. Complements
 * setup-branch for hand-curating a competitor set (e.g. adding named Indian
 * groceries the auto-discovery missed). POST { workspaceId, query, max?, indianOnly? }.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INDIAN = /\b(india|indian|desi|swad|swadeshi|apna|subzi|sabzi|taj|bazaar|bazar|mandi|namaste|gandhi|patel|spice|masala|grocer|halal|pakistan|south asian)\b/i;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  return !!worker && provided === worker;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body.workspaceId ?? "").trim();
  const query = String(body.query ?? "").trim();
  if (!workspaceId || !query) return NextResponse.json({ error: "workspaceId and query required" }, { status: 400 });
  const max = Math.min(Number(body.max) || 1, 8);
  const indianOnly = body.indianOnly !== false; // default true — this is for Indian-grocery curation

  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("target_business_id, vertical").eq("id", workspaceId).maybeSingle();
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  let geo: { lat: number; lng: number } | undefined, category: string | undefined, subtype: string[] | undefined;
  if (ws.target_business_id) {
    const { data: b } = await svc.from("business").select("category, attributes").eq("id", ws.target_business_id).maybeSingle();
    category = (b?.category as string) ?? undefined;
    subtype = (b?.attributes as any)?.subtype as string[] | undefined;
    geo = (b?.attributes as any)?.geo;
  }

  try {
    const cands = await discoverCandidates({ query, near: geo ? { lat: geo.lat, lng: geo.lng, radiusKm: 25 } : undefined, limit: Math.max(8, max * 3) });
    const pool = indianOnly ? cands.filter((c) => INDIAN.test(c.name)) : cands;
    const added: string[] = [];
    const skipped: string[] = [];
    for (const cand of pool.slice(0, max)) {
      try {
        await addCompetitor(workspaceId, { businessId: ws.target_business_id, geo, category, subtype }, cand, ws.vertical ?? "grocery");
        added.push(cand.name);
      } catch (e) { skipped.push(`${cand.name} (${(e as Error).message})`); }
    }
    if (added.length) { await enqueueWorkspaceCollection(workspaceId, { force: false }); void nudgeWorker(); }
    return NextResponse.json({ query, added, skipped, candidatesSeen: cands.map((c) => c.name).slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
