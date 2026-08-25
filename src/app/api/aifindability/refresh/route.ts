import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { requireOrg } from "@/lib/api";
import { refreshAiFindability } from "@/lib/aifindability";
import { createServiceClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Run the AI-findability scan. Two callers:
 *  - a cron / worker (x-worker-secret + { workspaceId }) — for a scheduled refresh;
 *  - the owner (authenticated) — runs it for their active workspace on demand.
 */
export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");

  if (secret && provided === secret) {
    const { workspaceId } = await req.json().catch(() => ({}));
    if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
    const svc = createServiceClient();
    const { data } = await svc.from("workspace").select("id,name,vertical,target_business_id").eq("id", workspaceId).maybeSingle();
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = await refreshAiFindability(data as WorkspaceRow);
    return NextResponse.json({ ok: true, score: r.score, queries: r.queries, engines: r.engines, empty: !!r.empty });
  }

  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const r = await refreshAiFindability(state.workspace);
  return NextResponse.json({ ok: true, score: r.score, queries: r.queries, engines: r.engines, empty: !!r.empty });
}
