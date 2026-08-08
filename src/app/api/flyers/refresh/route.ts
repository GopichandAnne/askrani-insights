import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshFlyers, flyersConfigured } from "@/lib/flyers";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Refresh a workspace's competitor flyer deals — scrape rivals' social FRESH,
 * download the flyer images, and vision-extract the sale items + prices. COST-
 * BEARING (Apify scrape + vision) and slow (per-profile scrape polling), so it's
 * gated (200 {activated:false} unless APIFY_TOKEN + an LLM are set), WORKER_SECRET
 * only, and never on a cron. POST { workspaceId, maxCompetitors?, postsPerCompetitor? }.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  return !!worker && provided === worker;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!flyersConfigured()) return NextResponse.json({ activated: false, reason: "Set APIFY_TOKEN and an LLM key to enable." });
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body.workspaceId ?? "").trim();
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("*").eq("id", workspaceId).maybeSingle();
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  try {
    const result = await refreshFlyers(ws as WorkspaceRow, {
      maxCompetitors: Number(body.maxCompetitors) || undefined,
      postsPerCompetitor: Number(body.postsPerCompetitor) || undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
