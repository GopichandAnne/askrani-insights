import { NextResponse } from "next/server";
import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { watchlistIds } from "@/lib/inspiration";

export const dynamic = "force-dynamic";

/**
 * Inspiration watchlist management. The watchlist lives on goals.inspirationWatch
 * (business ids to EMULATE), deliberately separate from competitor_edge so it never
 * touches rank/price. GET returns the current watch + candidate businesses (the
 * workspace's tracked competitors, which we already have content for). POST toggles
 * a business on/off the list. Scoped to the signed-in user's active workspace (RLS).
 */
export async function GET() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ watch: [], candidates: [] });
  const ws = state.workspace;
  const db = await createClient();
  const ids = await workspaceBusinessIds(ws, db);
  const { data: biz } = await db.from("business").select("id, canonical_name").in("id", ids.competitorIds.length ? ids.competitorIds : ["00000000-0000-0000-0000-000000000000"]);
  const candidates = ((biz ?? []) as any[]).map((b) => ({ id: b.id as string, name: (b.canonical_name as string) ?? "Unnamed" }));
  return NextResponse.json({ watch: watchlistIds(ws.goals as Record<string, any>), candidates });
}

export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;
  const body = (await req.json().catch(() => ({}))) as { action?: string; businessId?: string };
  const action = body.action;
  const businessId = typeof body.businessId === "string" ? body.businessId : "";
  if (!businessId || (action !== "add" && action !== "remove")) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Only allow watching a business that belongs to this workspace's set (guards the list).
  const db = await createClient();
  const ids = await workspaceBusinessIds(ws, db);
  if (action === "add" && !ids.all.includes(businessId)) return NextResponse.json({ error: "not_in_workspace" }, { status: 400 });

  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const cur = watchlistIds(goals);
  const next = action === "add" ? [...new Set([...cur, businessId])].slice(0, 20) : cur.filter((x) => x !== businessId);
  // Adding/removing changes what the pillar should show → drop the cached report so it rebuilds.
  const nextGoals = { ...goals, inspirationWatch: next };
  delete (nextGoals as Record<string, unknown>).inspiration;
  await svc.from("workspace").update({ goals: nextGoals }).eq("id", ws.id);
  return NextResponse.json({ ok: true, watch: next });
}
