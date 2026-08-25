import { NextResponse } from "next/server";
import { requireOrg, workspaceInOrg, unauthorized, badRequest } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { listFindabilityKeywords, suggestFindabilityKeywords, addFindabilityKeywords, removeFindabilityKeyword } from "@/lib/findability";
import { type WorkspaceRow } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

async function loadWs(workspaceId: string): Promise<WorkspaceRow | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("id, name, vertical, target_business_id, goals").eq("id", workspaceId).maybeSingle();
  return (data as WorkspaceRow | null) ?? null;
}

/** List the tracked search terms for the manage panel. */
export async function GET(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId") ?? "";
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();
  const ws = await loadWs(workspaceId);
  if (!ws) return badRequest("unknown workspace");
  return NextResponse.json({ keywords: await listFindabilityKeywords(ws) });
}

/** Manage terms: { action: "add" | "remove" | "suggest" }. add/suggest are free
 *  (the SCAN is what costs credits, via /api/findability/refresh). */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId ?? "");
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();
  const ws = await loadWs(workspaceId);
  if (!ws) return badRequest("unknown workspace");

  const action = String(body?.action ?? "");
  if (action === "suggest") {
    return NextResponse.json({ suggestions: await suggestFindabilityKeywords(ws) });
  }
  if (action === "add") {
    const terms = Array.isArray(body?.terms) ? body.terms : (body?.term ? [{ term: body.term }] : []);
    const added = await addFindabilityKeywords(ws, auth.orgId, terms);
    return NextResponse.json({ added, keywords: await listFindabilityKeywords(ws) });
  }
  if (action === "remove") {
    if (!body?.id) return badRequest("id required");
    await removeFindabilityKeyword(ws, String(body.id));
    return NextResponse.json({ ok: true, keywords: await listFindabilityKeywords(ws) });
  }
  return badRequest("unknown action");
}
