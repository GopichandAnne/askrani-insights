import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshCompetitorAds } from "@/lib/ads";
import { refreshFlyers } from "@/lib/flyers";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Deep-read finalize — runs the workspace-level competitive scans (competitor ADS
 * + FLYER/deal images) that aren't part of the per-business collection. Kicked
 * (fire-and-forget) from the job-drain hook once a deep read's collection finishes,
 * in its OWN function invocation (own 300s budget). This is what makes a deep read
 * the COMPLETE picture — ads + flyers are part of the paid scan (usage), not a
 * subscription-only feature. Both are best-effort: a thin result never fails it.
 * Authenticated with the shared WORKER_SECRET (or Vercel Cron), never by a user.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const cron = process.env.CRON_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (worker && provided === worker) return true;
  if (cron && req.headers.get("authorization") === `Bearer ${cron}`) return true;
  if (cron && req.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await req.json().catch(() => ({}));
  if (!workspaceId || typeof workspaceId !== "string") return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("id,name,vertical,target_business_id").eq("id", workspaceId).maybeSingle();
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ws = data as WorkspaceRow;

  const out: Record<string, unknown> = { workspaceId };
  try { out.ads = await refreshCompetitorAds(ws); } catch (e) { out.adsError = (e as Error).message; }
  try { out.flyers = await refreshFlyers(ws); } catch (e) { out.flyersError = (e as Error).message; }
  return NextResponse.json(out);
}
