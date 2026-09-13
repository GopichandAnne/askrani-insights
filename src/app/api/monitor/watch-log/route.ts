import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { buildAttention } from "@/lib/attention";

export const dynamic = "force-dynamic";

/**
 * Watch-log dump (superadmin) — the de-risking instrument for the 7-day Watch spike.
 *
 * READ-ONLY: it never collects, re-detects, or writes. It surfaces, per workspace,
 * exactly what a Watch would act on so a human can label it:
 *   • attention  — the deterministic alert CANDIDATES buildAttention() produces from
 *                  cached goals (what the Watch would push). Label each meaningful /
 *                  trivial / false. (H2 — signal quality.)
 *   • timeline   — per-business day-over-day market_snapshot metrics (rating, reviews,
 *                  rank, price) — the substrate to spot-check accuracy. (H1 — accuracy.)
 *   • events     — the append-only market_event change log for the window.
 *
 * GET /api/monitor/watch-log?workspaceId=<id>&days=8
 *   workspaceId omitted → dumps every workspace in the org (the cohort).
 */
export async function GET(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  if (!isSuperAdmin(await getUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const wsId = url.searchParams.get("workspaceId") || undefined;
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 8) || 8, 1), 30);
  const sinceDay = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10); // captured_on / *_seen_on are DATE cols

  const svc = createServiceClient();

  let wsq = svc.from("workspace").select("id,name,vertical,goals,target_business_id").eq("organization_id", auth.orgId);
  if (wsId) wsq = wsq.eq("id", wsId);
  const { data: workspaces, error: wsErr } = await wsq.order("created_at", { ascending: false }).limit(wsId ? 1 : 20);
  if (wsErr) return NextResponse.json({ error: wsErr.message }, { status: 500 });
  if (!workspaces?.length) return NextResponse.json({ error: "no workspaces for this org" }, { status: 404 });

  const out = await Promise.all(workspaces.map(async (ws: any) => {
    const goals = (ws.goals ?? {}) as Record<string, unknown>;

    // Alert CANDIDATES — deterministic, from cached goals only (no collection).
    let attention: { count: number; byLabel: Record<string, number>; items: unknown[] } | { error: string };
    try {
      const board = buildAttention({ name: ws.name as string, vertical: ws.vertical as string }, goals);
      const items = (board.items ?? []).map((i) => ({
        id: i.id, label: i.label, score: i.score, kind: i.kind, category: i.category,
        headline: i.headline, take: i.take, isNew: i.isNew, act: i.act?.move ?? null,
      }));
      const byLabel: Record<string, number> = {};
      for (const i of items) byLabel[i.label] = (byLabel[i.label] ?? 0) + 1;
      attention = { count: items.length, byLabel, items };
    } catch (e) {
      attention = { error: (e as Error).message };
    }

    // Businesses in this workspace (competitors + the target, if any) for readable names.
    const { data: edges } = await svc.from("competitor_edge").select("competitor_id").eq("workspace_id", ws.id as string);
    const bizIds = [...new Set([...(edges ?? []).map((e: any) => e.competitor_id as string), ...(ws.target_business_id ? [ws.target_business_id as string] : [])])];
    const { data: biz } = bizIds.length ? await svc.from("business").select("id,canonical_name").in("id", bizIds) : { data: [] as { id: string; canonical_name: string }[] };
    const nameById = new Map((biz ?? []).map((b: any) => [b.id, b.canonical_name as string]));

    // Day-over-day metrics (H1 accuracy substrate) — group snapshots by business.
    const { data: snaps } = bizIds.length
      ? await svc.from("market_snapshot")
          .select("business_id,captured_on,is_target,rating,review_count,rating_rank,avg_price,price_index,discoverability_pct,deals_active,ads_active")
          .eq("workspace_id", ws.id as string).gte("captured_on", sinceDay)
          .order("captured_on", { ascending: false }).limit(500)
      : { data: [] as any[] };
    const timeline: Record<string, unknown[]> = {};
    for (const s of snaps ?? []) {
      const name = nameById.get(s.business_id) ?? s.business_id;
      (timeline[name] ??= []).push({
        day: s.captured_on, isYou: s.is_target, rating: s.rating, reviews: s.review_count,
        rank: s.rating_rank, avgPrice: s.avg_price, priceIndex: s.price_index,
        ...(s.is_target ? { findability: s.discoverability_pct, deals: s.deals_active, ads: s.ads_active } : {}),
      });
    }
    const snapDays = [...new Set((snaps ?? []).map((s: any) => s.captured_on))].sort().reverse();

    // The change log for the window (what actually got detected).
    const { data: events } = await svc.from("market_event").select("*").eq("workspace_id", ws.id as string)
      .gte("first_seen_on", sinceDay).order("first_seen_on", { ascending: false }).limit(80);
    const eventsCompact = (events ?? []).map((e: any) => ({
      kind: e.kind ?? e.event_type ?? null, rival: e.rival ?? null,
      title: e.title ?? e.summary ?? null, detail: e.detail ?? null,
      significance: e.significance ?? null,
      firstSeen: e.first_seen_on ?? null, lastSeen: e.last_seen_on ?? null,
      business: e.business_id ? (nameById.get(e.business_id) ?? null) : null,
    }));

    return {
      workspaceId: ws.id, name: ws.name, vertical: ws.vertical,
      businesses: bizIds.map((id) => ({ id, name: nameById.get(id) ?? "?" })),
      snapshotCoverage: { days: snapDays.length, dates: snapDays },
      attention,
      eventCount: eventsCompact.length,
      events: eventsCompact,
      timeline,
    };
  }));

  return NextResponse.json({ generatedAt: new Date().toISOString(), windowDays: days, workspaceCount: out.length, workspaces: out });
}
