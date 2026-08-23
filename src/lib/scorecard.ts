import { buildWorkspaceReport } from "@/lib/report";
import { createClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * "You vs Your Market" scorecard — assembles four comparative 0–100 scores per
 * business (Rating, Price, Social reach, Findability) from data we already collect,
 * plus each business's composite and rank. Powers the activity-rings hero, the
 * gap-to-best table, the bullet tiles and the heatmap. AI-search visibility is a
 * separate (Phase-2) metric that slots in as a fifth ring later.
 *
 * Robust to the real gaps: any metric a business lacks is null (shown as "no data"),
 * and the composite averages only the metrics present.
 */

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const priceNum = (s?: string) => { const m = String(s ?? "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const round = (n: number) => Math.round(n);

export type MetricKey = "rating" | "price" | "social" | "ai" | "findability";
export interface MetricScore {
  key: MetricKey; label: string; color: "amber" | "green" | "violet" | "coral" | "teal";
  you: number | null; avg: number | null; best: number | null; bestName: string | null;
}
export interface BizScore { name: string; isYou: boolean; scores: Record<MetricKey, number | null>; composite: number | null }
export interface Scorecard {
  metrics: MetricScore[];   // ring order: outer → inner
  businesses: BizScore[];   // ranked by composite (desc), for heatmap + board
  composite: { you: number | null; avg: number | null; best: number | null; bestName: string | null; rank: number | null; total: number };
  headline: string;
  empty: boolean;
}

// outer → inner ring order (matches the locked hero design)
const METRICS: { key: MetricKey; label: string; color: MetricScore["color"] }[] = [
  { key: "rating", label: "Rating", color: "amber" },
  { key: "price", label: "Price", color: "green" },
  { key: "social", label: "Social reach", color: "violet" },
  { key: "ai", label: "AI search", color: "coral" },
  { key: "findability", label: "Findability", color: "teal" },
];

interface Raw { name: string; isYou: boolean; rating?: number | null; findPct?: number | null; avgPrice?: number | null; followers?: number | null; ai?: number | null }

// `db` override lets this run outside a request (worker / snapshot script) with a
// service-role client — `any` because SSR and service clients have distinct generic
// types but identical query APIs (mirrors buildWorkspaceReport).
export async function buildScorecard(ws: WorkspaceRow, db?: any): Promise<Scorecard> {
  const supabase = db ?? (await createClient());
  const [{ data: wRow }, report] = await Promise.all([
    supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle(),
    buildWorkspaceReport(ws, 30, db),
  ]);
  const goals = (wRow?.goals ?? {}) as Record<string, any>;

  const byKey = new Map<string, Raw>();
  const get = (name: string, isYou: boolean): Raw => {
    const k = normName(name);
    let r = byKey.get(k);
    if (!r) { r = { name, isYou }; byKey.set(k, r); }
    if (isYou) r.isYou = true;
    return r;
  };

  // rating (0–5)
  for (const x of report.reputation) if (x.rating != null) get(x.name, x.isTarget).rating = x.rating;
  // findability = share of local top-3
  for (const s of (goals.findability?.share ?? []) as { name: string; isYou: boolean; topThree: number; total: number }[]) {
    if (s.total > 0) get(s.name, s.isYou).findPct = (s.topThree / s.total) * 100;
  }
  // price: report offers first, then flyer fallback (your own + rivals')
  for (const p of report.pricing) if (p.avgPrice != null) get(p.name, p.isTarget).avgPrice = p.avgPrice;
  const own = get(ws.name, true);
  if (own.avgPrice == null) {
    const ps = ((goals.myFlyerDeals?.deals ?? []) as any[]).map((d) => priceNum(d.price)).filter((n): n is number => n != null);
    if (ps.length) own.avgPrice = ps.reduce((a, b) => a + b, 0) / ps.length;
  }
  const flyerByRival = new Map<string, number[]>();
  for (const d of (goals.flyerDeals?.deals ?? []) as any[]) {
    const n = priceNum(d.price); if (n == null) continue;
    const k = normName(d.rival); (flyerByRival.get(k) ?? flyerByRival.set(k, []).get(k)!).push(n);
  }
  for (const [k, arr] of flyerByRival) { const r = byKey.get(k); if (r && r.avgPrice == null && arr.length) r.avgPrice = arr.reduce((a, b) => a + b, 0) / arr.length; }
  // social followers (latest per channel, summed)
  const tl = (goals.socialTimeline ?? {}) as Record<string, { date: string; channel: string; followers?: number }[]>;
  for (const name of Object.keys(tl)) {
    const latest = new Map<string, { date: string; f: number }>();
    for (const p of tl[name]) { if (p.followers == null) continue; const e = latest.get(p.channel); if (!e || p.date > e.date) latest.set(p.channel, { date: p.date, f: p.followers }); }
    let total = 0; for (const v of latest.values()) total += v.f;
    if (total > 0) get(name, false).followers = total;
  }
  // AI search visibility (0–100 per business, from the ai-findability engine) — only
  // when the scan produced a real signal (needs a search-grounded engine).
  const aiBy = (goals.aiFindability && !goals.aiFindability.empty ? goals.aiFindability.byBiz ?? {} : {}) as Record<string, { name: string; score: number }>;
  for (const k of Object.keys(aiBy)) get(aiBy[k].name, false).ai = aiBy[k].score;
  get(ws.name, true); // ensure target present

  const all = [...byKey.values()];
  const prices = all.map((r) => r.avgPrice).filter((n): n is number => n != null);
  const minP = prices.length ? Math.min(...prices) : 0, maxP = prices.length ? Math.max(...prices) : 0;
  const priceScore = (v?: number | null) => v == null ? null : (maxP === minP ? 60 : round(((maxP - v) / (maxP - minP)) * 100));
  const folls = all.map((r) => r.followers).filter((n): n is number => n != null);
  const maxF = Math.max(...folls, 1);
  const socialScore = (v?: number | null) => v == null ? null : round(Math.min(100, (v / maxF) * 100));

  const bscores: BizScore[] = all.map((r) => {
    const scores: Record<MetricKey, number | null> = {
      rating: r.rating != null ? round((r.rating / 5) * 100) : null,
      price: priceScore(r.avgPrice),
      social: socialScore(r.followers),
      ai: r.ai != null ? r.ai : null,
      findability: r.findPct != null ? round(r.findPct) : null,
    };
    const vals = Object.values(scores).filter((n): n is number => n != null);
    return { name: r.name, isYou: r.isYou, scores, composite: vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  });

  const youBiz = bscores.find((b) => b.isYou);
  const metrics: MetricScore[] = METRICS.map((m) => {
    const you = youBiz?.scores[m.key] ?? null;
    const rivals = bscores.filter((b) => !b.isYou).map((b) => ({ name: b.name, v: b.scores[m.key] })).filter((x): x is { name: string; v: number } => x.v != null);
    const avg = rivals.length ? round(rivals.reduce((a, b) => a + b.v, 0) / rivals.length) : null;
    const bestRow = rivals.length ? rivals.reduce((a, b) => (b.v > a.v ? b : a)) : null;
    return { key: m.key, label: m.label, color: m.color, you, avg, best: bestRow?.v ?? null, bestName: bestRow?.name ?? null };
  });

  const ranked = [...bscores].filter((b) => b.composite != null).sort((a, b) => b.composite! - a.composite!);
  const rank = youBiz?.composite != null ? ranked.findIndex((b) => b.isYou) + 1 : null;
  const rivalComps = bscores.filter((b) => !b.isYou && b.composite != null).map((b) => b.composite!);
  const compAvg = rivalComps.length ? round(rivalComps.reduce((a, b) => a + b, 0) / rivalComps.length) : null;
  const compBest = bscores.filter((b) => !b.isYou && b.composite != null).sort((a, b) => b.composite! - a.composite!)[0];

  const empty = !youBiz || youBiz.composite == null;
  return {
    metrics,
    businesses: ranked.length ? ranked : bscores,
    composite: { you: youBiz?.composite ?? null, avg: compAvg, best: compBest?.composite ?? null, bestName: compBest?.name ?? null, rank, total: ranked.length },
    headline: empty ? "" : buildHeadline(metrics),
    empty,
  };
}

function buildHeadline(metrics: MetricScore[]): string {
  const scored = metrics.filter((m) => m.you != null && m.avg != null) as (MetricScore & { you: number; avg: number })[];
  const ahead = scored.filter((m) => m.you >= m.avg).sort((a, b) => (b.you - b.avg) - (a.you - a.avg));
  const behind = scored.filter((m) => m.you < m.avg).sort((a, b) => (a.you - a.avg) - (b.you - b.avg));
  const strong = ahead[0]?.label.toLowerCase();
  const weak = behind.slice(0, 2).map((m) => m.label.toLowerCase());
  if (strong && weak.length) return `Strong on ${strong}, but trailing on ${weak.join(" & ")} — that's where the points are.`;
  if (weak.length) return `Trailing the market on ${weak.join(" & ")} — your biggest openings.`;
  if (strong) return `Ahead of the market on ${strong} — keep it up.`;
  return "Here's how you stack up against your market.";
}
