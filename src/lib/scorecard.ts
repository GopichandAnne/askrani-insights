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

// The "price" ring means different things per vertical. A dentist publishes no
// menu — the money signal is new-patient specials + published procedure prices —
// so it reads as "Offers & pricing", not "Price". Restaurants/grocery keep "Price".
const METRIC_LABEL_BY_VERTICAL: Record<string, Partial<Record<MetricKey, string>>> = {
  dental: { price: "Offers & pricing" },
  salon: { price: "Offers & pricing" },
  fitness: { price: "Pricing & offers" },
  real_estate: { price: "Pricing" },
};
const labelFor = (key: MetricKey, base: string, vertical?: string): string =>
  METRIC_LABEL_BY_VERTICAL[vertical ?? ""]?.[key] ?? base;

interface Raw { name: string; isYou: boolean; rating?: number | null; findPct?: number | null; avgPrice?: number | null; followers?: number | null; ai?: number | null; items?: { name: string; price: number }[]; priceBasis?: number | null }

// Vertical-agnostic item normalizer for like-for-like matching — strips
// parentheticals, sizes/units and stray numbers, keeps the item words. No
// hardcoded vocab, so it matches "Chicken Biryani" (restaurant), "Paneer 1lb"
// (grocery), "Gel Manicure" (salon) alike.
const normItem = (s: string): string => s.toLowerCase()
  .replace(/\([^)]*\)/g, " ")
  .replace(/\b\d+(?:\.\d+)?\s*(?:pcs?|pieces?|oz|ml|lbs?|kg|ct|pack)\b/g, " ")
  .replace(/\b\d+(?:\.\d+)?\b/g, " ")
  .replace(/[^a-z ]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

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
  // findability = share of local top-3. NB: the findability report labels the target
  // as "You" (not its canonical name), so route the isYou row onto the target itself
  // — otherwise it spawns a phantom business and the target's findability goes missing.
  for (const s of (goals.findability?.share ?? []) as { name: string; isYou: boolean; topThree: number; total: number }[]) {
    if (s.total > 0) get(s.isYou ? ws.name : s.name, s.isYou).findPct = (s.topThree / s.total) * 100;
  }
  // price: report offers first, then flyer fallback (your own + rivals'). Keep the
  // per-item prices too — the score is built like-for-like from them below.
  for (const p of report.pricing) { const r = get(p.name, p.isTarget); if (p.avgPrice != null) r.avgPrice = p.avgPrice; if (p.items?.length) r.items = p.items; }
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

  // ── Price basis: LIKE-FOR-LIKE, not average-of-everything ───────────────────
  // Compare businesses only on items they SHARE (a "common basket"), so menu size
  // and composition (catering trays, big platters, a longer scraped menu) can't
  // skew the score. Build the basket from items offered by ≥2 businesses (matched
  // by the vertical-agnostic normalizer). A business is scored on its own prices
  // for those shared items. Fallbacks keep it honest when data is thin:
  //   • no real shared basket in the market → robust MEDIAN of each business's
  //     own items (median resists the platter/catering skew the old mean had),
  //   • no items at all (flyer-only) → the flyer average already on avgPrice.
  // Intelligent matching: the cached LLM canonical map (goals.priceCanon) collapses
  // synonyms / other languages / spelling & portion variants (idly=idli, beets=
  // chukandar, gel manicure≈gel nails) onto one label, vertical-aware. Falls back to
  // the deterministic normalizer for anything the LLM didn't group (or if uncomputed).
  const canon = (goals.priceCanon?.canon ?? {}) as Record<string, string>;
  const clusterKey = (name: string): string => { const nn = normItem(name); return canon[nn] ?? nn; };
  const bizByItem = new Map<string, Set<string>>();
  for (const r of all) for (const it of r.items ?? []) { const nn = clusterKey(it.name); if (nn.length < 3) continue; (bizByItem.get(nn) ?? bizByItem.set(nn, new Set()).get(nn)!).add(normName(r.name)); }
  const commonBasket = new Set([...bizByItem].filter(([, s]) => s.size >= 2).map(([n]) => n));
  const basketMode = commonBasket.size >= 3; // enough overlap to be a real basket
  const priceBasisOf = (r: Raw): number | null => {
    const items = r.items ?? [];
    if (basketMode) {
      const bp = items.filter((it) => commonBasket.has(clusterKey(it.name))).map((it) => it.price);
      return bp.length >= 2 ? bp.reduce((a, b) => a + b, 0) / bp.length : null; // too little overlap → no fair price score
    }
    const ps = items.map((it) => it.price);
    return ps.length ? median(ps) : (r.avgPrice ?? null);
  };
  for (const r of all) r.priceBasis = priceBasisOf(r);

  const prices = all.map((r) => r.priceBasis).filter((n): n is number => n != null);
  const minP = prices.length ? Math.min(...prices) : 0, maxP = prices.length ? Math.max(...prices) : 0;
  const priceScore = (v?: number | null) => v == null ? null : (maxP === minP ? 60 : round(((maxP - v) / (maxP - minP)) * 100));
  const folls = all.map((r) => r.followers).filter((n): n is number => n != null);
  const maxF = Math.max(...folls, 1);
  const socialScore = (v?: number | null) => v == null ? null : round(Math.min(100, (v / maxF) * 100));

  const bscores: BizScore[] = all.map((r) => {
    const scores: Record<MetricKey, number | null> = {
      rating: r.rating != null ? round((r.rating / 5) * 100) : null,
      price: priceScore(r.priceBasis),
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
    return { key: m.key, label: labelFor(m.key, m.label, ws.vertical), color: m.color, you, avg, best: bestRow?.v ?? null, bestName: bestRow?.name ?? null };
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
