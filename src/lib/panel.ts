import { createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * The append-only MARKET PANEL — the compounding data asset. Each cycle we write
 * ONE immutable metrics row per business (target + every competitor) into
 * market_snapshot: ratings, price, rank, presence, activity + compact derived
 * signals (theme/format labels). NO raw third-party text — metrics only — so the
 * panel is aggregatable and free of Google/Yelp/Meta resale-ToS issues.
 *
 * Append-only: one row per (business_id, captured_on); re-runs the same day are
 * no-ops (insert … on conflict do nothing). The history is never overwritten —
 * that's the point. Called at the end of the warm step, when all pillar caches
 * are fresh. Value = time × coverage, so this runs every cycle from day one.
 */

const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
/** 5-char geohash ≈ a ~5km market cell — the neighborhood bucket for rollups. */
function geohash(lat: number, lng: number, prec = 5): string {
  let idx = 0, bit = 0, even = true, hash = "";
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  while (hash.length < prec) {
    if (even) { const mid = (lngMin + lngMax) / 2; if (lng > mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx = idx * 2; lngMax = mid; } }
    else { const mid = (latMin + latMax) / 2; if (lat > mid) { idx = idx * 2 + 1; latMin = mid; } else { idx = idx * 2; latMax = mid; } }
    even = !even;
    if (++bit === 5) { hash += B32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

/** Rough city from a stored address ("…, Leander, TX 78641" → "Leander"). */
function cityFromAddress(addr?: string): string | null {
  if (!addr) return null;
  const parts = String(addr).split(",").map((s) => s.trim()).filter(Boolean);
  // the segment just before a "TX"/"TX 78641" state token
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^[A-Z]{2}(\s+\d{5})?$/.test(parts[i])) return parts[i - 1] || null;
  }
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Append-only MARKET EVENT log — preserves the ARTIFACTS a market produces over
 * time (deals, ad moves, breakout posts, rising formats, unmet demand) with the
 * date first seen, so seasonality becomes queryable ("what did local groceries
 * run last Diwali?"). Companion to snapshotMarket (metrics). Derived text/labels
 * only — never raw third-party media. A row is created once (first_seen_on
 * immutable); re-seeing it extends last_seen_on. Called from the warm hook.
 */
export async function recordMarketEvents(ws: WorkspaceRow, _db?: RlsClient): Promise<number> {
  const svc = createServiceClient();
  const { data: wsRow } = await svc.from("workspace").select("organization_id, goals").eq("id", ws.id).maybeSingle();
  const orgId = (wsRow?.organization_id as string | undefined) ?? null;
  const goals = (wsRow?.goals as Record<string, any>) ?? {};

  // market location (from the target business) for geo/seasonal bucketing
  let geohashV: string | null = null, cityV: string | null = null;
  if (ws.target_business_id) {
    const { data: tb } = await svc.from("business").select("attributes").eq("id", ws.target_business_id).maybeSingle();
    const a = (tb?.attributes as any) ?? {};
    if (a.geo?.lat != null && a.geo?.lng != null) geohashV = geohash(a.geo.lat, a.geo.lng);
    cityV = cityFromAddress(a.address);
  }

  type Ev = { kind: string; rival: string | null; title: string; detail: string | null; metric: number | null; url: string | null };
  const byFp = new Map<string, Ev>();
  const add = (kind: string, e: Partial<Ev> & { title?: string }) => {
    const title = clean(e.title); if (!title) return;
    const rival = e.rival ? clean(e.rival) : null;
    const fp = `${kind}:${norm(rival ?? "")}:${norm(title).slice(0, 60)}`;
    if (byFp.has(fp)) return;
    byFp.set(fp, { kind, rival, title: title.slice(0, 200), detail: e.detail ? clean(e.detail).slice(0, 300) : null, metric: e.metric ?? null, url: e.url ?? null });
  };

  for (const d of (goals.deals?.deals ?? []) as any[]) add("deal", { rival: d.rival, title: d.deal, detail: d.item });
  for (const d of (goals.flyerDeals?.deals ?? []) as any[]) add("deal", { rival: d.rival, title: d.item, detail: [d.price, d.terms].filter(Boolean).join(" · "), url: d.postUrl });
  const topAdvertiser = (goals.ads?.advertisers ?? [])[0];
  for (const p of (goals.ads?.patterns ?? []) as any[]) add("ad_move", { rival: topAdvertiser, title: p.pattern, detail: p.example });
  for (const b of (goals.socialPulse?.breakouts ?? []) as any[]) add("breakout", { rival: b.rival, title: b.caption, metric: b.multiple, detail: `${b.eng} engagement` });
  for (const f of (goals.socialPulse?.risingFormats ?? []) as string[]) add("winning_format", { title: f });
  for (const dm of (goals.demand?.demands ?? []) as any[]) add("demand", { title: dm.need, detail: dm.signal });

  const events = [...byFp.entries()];
  if (!events.length) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const rows = events.map(([fp, e]) => ({
    first_seen_on: today, last_seen_on: today,
    workspace_id: ws.id, organization_id: orgId, business_id: null,
    vertical: ws.vertical, subtype: null, city: cityV, geohash: geohashV,
    kind: e.kind, rival: e.rival, title: e.title, detail: e.detail, metric: e.metric, url: e.url, fingerprint: fp,
  }));

  // create new ones (first_seen preserved); then extend last_seen for re-seen ones
  const ins = await svc.from("market_event").upsert(rows, { onConflict: "workspace_id,fingerprint", ignoreDuplicates: true }).select("id");
  if (ins.error) throw new Error(`market_event: ${ins.error.message}`);
  await svc.from("market_event").update({ last_seen_on: today }).eq("workspace_id", ws.id).in("fingerprint", events.map(([fp]) => fp)).lt("last_seen_on", today);
  return rows.length;
}

export interface TrendPoint {
  date: string;
  youRating: number | null; mktRating: number | null;
  youPrice: number | null; mktPrice: number | null;
  rank: number | null; marketSize: number | null;
  deals: number | null; ads: number | null;
}
export interface MarketTrends { points: TrendPoint[]; latest: TrendPoint | null; days: number }

/** Read the workspace's market panel as a you-vs-market time series (Phase 2). */
export async function getMarketTrends(ws: WorkspaceRow): Promise<MarketTrends> {
  const svc = createServiceClient();
  const { data } = await svc
    .from("market_snapshot")
    .select("captured_on, is_target, rating, avg_price, rating_rank, market_size, deals_active, ads_active")
    .eq("workspace_id", ws.id)
    .order("captured_on", { ascending: true });
  const rows = (data ?? []) as any[];

  const byDate = new Map<string, any[]>();
  for (const r of rows) { const k = r.captured_on as string; (byDate.get(k) ?? byDate.set(k, []).get(k)!).push(r); }

  const avg = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null);
  const points: TrendPoint[] = [...byDate.entries()].map(([date, rs]) => {
    const you = rs.find((r) => r.is_target);
    const rivals = rs.filter((r) => !r.is_target);
    return {
      date,
      youRating: you?.rating ?? null,
      mktRating: avg(rivals.map((r) => r.rating).filter((v): v is number => typeof v === "number")),
      youPrice: you?.avg_price ?? null,
      mktPrice: avg(rivals.map((r) => r.avg_price).filter((v): v is number => typeof v === "number")),
      rank: you?.rating_rank ?? null,
      marketSize: you?.market_size ?? null,
      deals: you?.deals_active ?? null,
      ads: you?.ads_active ?? null,
    };
  });

  return { points, latest: points[points.length - 1] ?? null, days: points.length };
}

/** Write today's snapshot row for every business in the workspace. Idempotent. */
export async function snapshotMarket(ws: WorkspaceRow, db?: RlsClient): Promise<number> {
  const svc = createServiceClient();
  const supabase = db ?? (svc as unknown as RlsClient);

  const { data: wsRow } = await svc.from("workspace").select("organization_id, goals").eq("id", ws.id).maybeSingle();
  const orgId = (wsRow?.organization_id as string | undefined) ?? null;
  const goals = (wsRow?.goals as Record<string, any>) ?? {};

  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.targetId) return 0;

  const report = await buildWorkspaceReport(ws, 30, supabase as any);
  const repById = new Map(report.reputation.map((r) => [r.businessId, r]));
  const priceById = new Map(report.pricing.map((p) => [p.businessId, p]));

  // market context: rank (rated desc), size, avg price
  const rated = report.reputation.filter((r) => typeof r.rating === "number").sort((a, b) => (b.rating as number) - (a.rating as number));
  const rankById = new Map(rated.map((r, i) => [r.businessId, i + 1]));
  const marketSize = rated.length;
  const prices = report.pricing.map((p) => p.avgPrice).filter((v): v is number => typeof v === "number");
  const mktAvgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const { data: biz } = await svc.from("business").select("id, canonical_name, attributes").in("id", ids.all.length ? ids.all : [ids.targetId]);
  const bizById = new Map<string, any>((biz ?? []).map((b: any) => [b.id, b]));

  const themes = (goals.themeHistory as any[] | undefined)?.slice(-1)[0]?.themes ?? goals.pulse?.emerging?.map((e: any) => ({ theme: e.theme, sentiment: "negative" })) ?? null;
  const formats = (goals.socialThemeHistory as any[] | undefined)?.slice(-1)[0]?.formats ?? goals.socialPulse?.risingFormats ?? null;
  const today = new Date().toISOString().slice(0, 10);

  const rows = ids.all.map((id) => {
    const b = bizById.get(id);
    const attrs = (b?.attributes as any) ?? {};
    const rep = repById.get(id);
    const pr = priceById.get(id);
    const isTarget = id === ids.targetId;
    const geo = attrs.geo;
    return {
      captured_on: today,
      business_id: id,
      workspace_id: ws.id,
      organization_id: orgId,
      vertical: ws.vertical,
      subtype: Array.isArray(attrs.subtype) ? attrs.subtype[0] ?? null : (attrs.subtype ?? null),
      city: cityFromAddress(attrs.address),
      geohash: geo?.lat != null && geo?.lng != null ? geohash(geo.lat, geo.lng) : null,
      is_target: isTarget,
      rating: rep?.rating ?? null,
      review_count: rep?.reviewCount ?? null,
      rating_rank: rankById.get(id) ?? null,
      market_size: marketSize,
      avg_price: pr?.avgPrice ?? null,
      price_index: pr?.avgPrice != null && mktAvgPrice ? Number((pr.avgPrice / mktAvgPrice).toFixed(3)) : null,
      // target-only enrichment (competitor rows keep the core metrics)
      discoverability_pct: isTarget ? (goals.you?.discoverability?.scorePct ?? null) : null,
      deals_active: isTarget ? (goals.deals?.deals?.length ?? null) : null,
      ads_active: isTarget ? (goals.ads?.ads?.length ?? null) : null,
      top_themes: isTarget ? themes : null,
      top_formats: isTarget ? formats : null,
    };
  });

  // append-only: one row per (workspace, business, day) — a business that's a
  // target in its own workspace AND a competitor in another is recorded correctly
  // from each perspective (is_target/rank are workspace-relative). Same-day
  // re-runs are no-ops. Benchmarks dedup by business_id.
  const { error } = await svc.from("market_snapshot").upsert(rows, { onConflict: "workspace_id,business_id,captured_on", ignoreDuplicates: true });
  if (error) throw new Error(`market_snapshot: ${error.message}`);
  return rows.length;
}
