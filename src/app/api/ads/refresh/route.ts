import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshCompetitorAds } from "@/lib/ads";
import { adLibraryConfigured } from "@/lib/providers/apify/platforms";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Refresh competitor ads for a workspace by scraping each rival's Meta Ad Library
 * entries. COST-BEARING (Apify) — gated (200 {activated:false} unless APIFY_TOKEN
 * + APIFY_AD_LIBRARY_ACTOR are set), WORKER_SECRET-only, never on a cron.
 * POST { workspaceId, maxCompetitors?, limitPerAdvertiser? }.
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
  if (!adLibraryConfigured()) {
    return NextResponse.json({ activated: false, reason: "Set APIFY_TOKEN + APIFY_AD_LIBRARY_ACTOR to enable." });
  }
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body.workspaceId ?? "").trim();
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("*").eq("id", workspaceId).maybeSingle();
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  try {
    const result = await refreshCompetitorAds(ws as WorkspaceRow, {
      maxCompetitors: Number(body.maxCompetitors) || undefined,
      limitPerAdvertiser: Number(body.limitPerAdvertiser) || undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
