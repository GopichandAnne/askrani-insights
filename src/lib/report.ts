import { createClient, type RlsClient } from "@/lib/supabase/server";
import { WorkspaceRow, workspaceBusinessIds } from "@/lib/workspace";
import { workspaceCostSummary, CostSummary } from "@/lib/costs";

/**
 * Assembles the exportable market report for a workspace (guide §12 read-side).
 * One aggregation the /reports page renders and the CSV export serialises: market
 * snapshot, pricing per business, reputation, recent events, open recommendations,
 * and the monitoring cost breakdown. Reads go through the RLS client (tenant-safe);
 * the cost roll-up uses the service client internally.
 */

export interface PricingRow {
  businessId: string;
  name: string;
  isTarget: boolean;
  offers: number;
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}
export interface RatingSource {
  source: string; // 'google' | 'yelp' | ...
  rating: number;
  reviewCount: number | null;
}
export interface ReputationRow {
  businessId: string;
  name: string;
  isTarget: boolean;
  rating: number | null; // primary = the most-reviewed source
  reviewCount: number | null;
  reviewsSeen: number;
  sources: RatingSource[]; // per-source ratings (Google, Yelp, …)
}
export interface EventRow {
  id: string;
  type: string;
  significance: number;
  summary: string;
  business: string;
  at: string | null;
}
export interface RecRow {
  id: string;
  category: string;
  title: string;
  action: string;
  priority: number;
}
export interface WorkspaceReport {
  workspace: WorkspaceRow;
  generatedAt: string;
  snapshot: {
    monitoredBusinesses: number;
    competitors: number;
    offers: number;
    events30d: number;
    openRecommendations: number;
    reviewsSeen: number;
  };
  pricing: PricingRow[];
  reputation: ReputationRow[];
  events: EventRow[];
  recommendations: RecRow[];
  cost: CostSummary;
}

const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;

// Optional pre-built client. Pass a service-role client to run OUTSIDE a request
// (e.g. the collection worker warming caches) where there's no user session for
// the RLS client. `any` because the SSR and service clients have distinct generic
// types but identical query APIs. Defaults to the request-scoped RLS client.
export type DbOverride = RlsClient;

export async function buildWorkspaceReport(ws: WorkspaceRow, days = 30, db?: DbOverride): Promise<WorkspaceReport> {
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const [{ data: bizRows }, { data: offers }, { data: reviews }, { data: events }, { data: recs }, cost] =
    await Promise.all([
      supabase.from("business").select("id, canonical_name").in("id", scope),
      supabase
        .from("offer")
        .select("business_id, entity_text, pricing")
        .in("business_id", scope)
        .limit(4000),
      supabase
        .from("content_item")
        .select("business_id, platform, text, observed_at")
        .in("business_id", scope)
        .in("platform", ["yelp", "google"])
        .order("observed_at", { ascending: false })
        .limit(2000),
      supabase
        .from("market_event")
        .select("id, event_type, significance, summary, time_start, business:business_id(canonical_name)")
        .eq("workspace_id", ws.id)
        .gte("created_at", cutoff)
        .order("significance", { ascending: false })
        .limit(50),
      supabase
        .from("recommendation")
        .select("id, category, title, action, priority")
        .eq("workspace_id", ws.id)
        .neq("status", "dismissed")
        .order("priority", { ascending: false })
        .limit(50),
      workspaceCostSummary(ws.id, days),
    ]);

  const nameById = new Map<string, string>();
  for (const b of bizRows ?? []) nameById.set((b as any).id, (b as any).canonical_name);
  const nameOf = (id: string) => nameById.get(id) ?? "—";
  const isTarget = (id: string) => id === ids.targetId;

  // ── pricing per business (dedupe by entity_text, keep numeric prices) ──
  const priceAcc = new Map<string, { seen: Set<string>; prices: number[] }>();
  for (const o of offers ?? []) {
    const bid = (o as any).business_id as string;
    const label = String((o as any).entity_text ?? "").toLowerCase();
    const amt = Number((o as any).pricing?.amount);
    const acc = priceAcc.get(bid) ?? { seen: new Set<string>(), prices: [] };
    if (label && acc.seen.has(label)) {
      priceAcc.set(bid, acc);
      continue;
    }
    if (label) acc.seen.add(label);
    if (Number.isFinite(amt) && amt > 0) acc.prices.push(amt);
    priceAcc.set(bid, acc);
  }
  const pricing: PricingRow[] = scope
    .filter((id) => nameById.has(id))
    .map((id) => {
      const acc = priceAcc.get(id);
      const prices = acc?.prices ?? [];
      const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
      return {
        businessId: id,
        name: nameOf(id),
        isTarget: isTarget(id),
        offers: acc?.seen.size ?? 0,
        avgPrice: avg != null ? Number(avg.toFixed(2)) : null,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
      };
    })
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || b.offers - a.offers);

  // ── reputation per business, PER SOURCE (Google, Yelp, …). Each source
  //    publishes one "Rated X★ … from Y reviews" summary; we key by platform so
  //    ratings from every source show side by side. Primary = most-reviewed. ──
  const repAcc = new Map<string, { seen: number; bySource: Map<string, { rating: number; reviewCount: number | null }> }>();
  for (const r of reviews ?? []) {
    const bid = (r as any).business_id as string;
    const platform = String((r as any).platform ?? "");
    const acc = repAcc.get(bid) ?? { seen: 0, bySource: new Map() };
    acc.seen++;
    const m = RATING_RE.exec(String((r as any).text ?? ""));
    if (m && !acc.bySource.has(platform)) {
      acc.bySource.set(platform, { rating: Number(m[1]), reviewCount: Number(m[2].replace(/,/g, "")) });
    }
    repAcc.set(bid, acc);
  }
  const reputation: ReputationRow[] = scope
    .filter((id) => nameById.has(id))
    .map((id) => {
      const acc = repAcc.get(id);
      const sources: RatingSource[] = [...(acc?.bySource ?? new Map()).entries()]
        .map(([source, v]) => ({ source, rating: v.rating, reviewCount: v.reviewCount }))
        .sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
      const primary = sources[0];
      return {
        businessId: id,
        name: nameOf(id),
        isTarget: isTarget(id),
        rating: primary?.rating ?? null,
        reviewCount: primary?.reviewCount ?? null,
        reviewsSeen: acc?.seen ?? 0,
        sources,
      };
    })
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || (b.rating ?? 0) - (a.rating ?? 0));

  const eventRows: EventRow[] = (events ?? []).map((e) => ({
    id: (e as any).id,
    type: String((e as any).event_type),
    significance: Number((e as any).significance ?? 0),
    summary: (e as any).summary ?? "",
    business: (e as any).business?.canonical_name ?? "—",
    at: (e as any).time_start ?? null,
  }));

  const recRows: RecRow[] = (recs ?? []).map((r) => ({
    id: (r as any).id,
    category: (r as any).category ?? "",
    title: (r as any).title ?? "",
    action: (r as any).action ?? "",
    priority: Number((r as any).priority ?? 0),
  }));

  const reviewsSeen = reputation.reduce((a, r) => a + r.reviewsSeen, 0);

  return {
    workspace: ws,
    generatedAt: new Date().toISOString(),
    snapshot: {
      monitoredBusinesses: ids.all.length,
      competitors: ids.competitorIds.length,
      offers: (offers ?? []).length,
      events30d: eventRows.length,
      openRecommendations: recRows.length,
      reviewsSeen,
    },
    pricing,
    reputation,
    events: eventRows,
    recommendations: recRows,
    cost,
  };
}
