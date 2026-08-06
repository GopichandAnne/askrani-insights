import { createClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Per-competitor rollup — everything an owner wants to know about ONE rival in a
 * single card, instead of hopping between the Offers / Feed / Reputation screens:
 * their rating, how their prices sit vs yours, their latest move, their best-
 * performing recent post, and where to go look at them. Reuses buildWorkspaceReport
 * for pricing + reputation (already keyed by businessId) and adds the rest.
 */

const SOCIAL = new Set(["instagram", "facebook", "tiktok", "youtube"]);
const BOOKING_HOST =
  /vagaro|boulevard|blvd\.co|glossgenius|mindbody|squareup|square\.site|acuityscheduling|squarespace-scheduling|setmore|gettimely|timelyapp|zenoti|aestheticrecord|withcherry|gocherry|booksy|phorest|fresha|calendly|schedulicity|janeapp/i;

export interface CompetitorPost { platform: string; url: string | null; caption: string; likes?: number; views?: number; comments?: number }
export interface CompetitorChange { type: string; summary: string; at: string | null }

export interface CompetitorCard {
  businessId: string;
  name: string;
  relation: string;
  distanceKm: number | null;
  link: { url: string; kind: "booking" | "website" } | null;
  subtype: string[];
  rating: { score: number; reviewCount: number | null; source: string } | null;
  /** every source's rating (Google, Yelp, …) — shown in the expanded detail. */
  ratingSources: { source: string; rating: number; reviewCount: number | null }[];
  price: { avg: number | null; min: number | null; max: number | null; items: number; vsYou: "higher" | "lower" | "similar" | null; deltaPct: number | null };
  /** recent moves, newest first (card shows the first; the rest on expand). */
  recentChanges: CompetitorChange[];
  /** best-performing recent posts (card shows the first; the rest on expand). */
  topPosts: CompetitorPost[];
  /** a sample of what they sell + prices (menu items / services). */
  offers: { item: string; price: number | null }[];
}

export interface CompetitorCardsResult {
  you: { name: string; avgPrice: number | null; rating: number | null };
  cards: CompetitorCard[];
}

function haversineKm(a?: { lat: number; lng: number }, b?: { lat: number; lng: number }): number | null {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return Number((2 * R * Math.asin(Math.sqrt(h))).toFixed(1));
}

const metricsOf = (m: unknown): { views?: number; likes?: number; comments?: number } | null =>
  Array.isArray(m) ? ((m.find((x) => (x as { type?: string })?.type === "metrics") as never) ?? null) : null;
const eng = (mm: { views?: number; likes?: number; comments?: number } | null) =>
  (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;

export async function competitorCards(ws: WorkspaceRow): Promise<CompetitorCardsResult> {
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws);
  const compIds = ids.competitorIds;
  const report = await buildWorkspaceReport(ws);

  const priceById = new Map(report.pricing.map((p) => [p.businessId, p]));
  const repById = new Map(report.reputation.map((r) => [r.businessId, r]));
  const you = {
    name: report.pricing.find((p) => p.isTarget)?.name ?? ws.name,
    avgPrice: report.pricing.find((p) => p.isTarget)?.avgPrice ?? null,
    rating: report.reputation.find((r) => r.isTarget)?.rating ?? null,
  };

  if (!compIds.length) return { you, cards: [] };

  const [{ data: edges }, { data: target }, { data: events }, { data: posts }, { data: idents }, { data: offerRows }] =
    await Promise.all([
      supabase
        .from("competitor_edge")
        .select("competitor_id, relation, score, competitor:competitor_id(canonical_name, website, attributes)")
        .eq("workspace_id", ws.id)
        .order("score", { ascending: false }),
      ids.targetId
        ? supabase.from("business").select("attributes").eq("id", ids.targetId).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("market_event")
        .select("business_id, event_type, summary, time_start")
        .eq("workspace_id", ws.id)
        .in("business_id", compIds)
        .order("time_start", { ascending: false })
        .limit(600),
      supabase
        .from("content_item")
        .select("business_id, platform, text, media, url, observed_at")
        .in("business_id", compIds)
        .in("platform", [...SOCIAL])
        .order("observed_at", { ascending: false })
        .limit(1500),
      supabase.from("external_identity").select("business_id, platform, url").in("business_id", compIds),
      supabase
        .from("offer")
        .select("business_id, entity_text, pricing, observed_at")
        .in("business_id", compIds)
        .order("observed_at", { ascending: false })
        .limit(3000),
    ]);

  const targetGeo = (target as { attributes?: { geo?: { lat: number; lng: number } } } | null)?.attributes?.geo;

  // recent changes per competitor (newest first, up to 6)
  const changesByBiz = new Map<string, CompetitorChange[]>();
  for (const e of events ?? []) {
    const bid = (e as { business_id: string }).business_id;
    const arr = changesByBiz.get(bid) ?? [];
    if (arr.length < 6) {
      arr.push({
        type: String((e as { event_type: string }).event_type),
        summary: (e as { summary: string }).summary ?? "",
        at: (e as { time_start: string | null }).time_start ?? null,
      });
      changesByBiz.set(bid, arr);
    }
  }

  // top-performing recent posts per competitor (by engagement, up to 4)
  const postsByBiz = new Map<string, (CompetitorPost & { _eng: number })[]>();
  for (const p of posts ?? []) {
    const bid = (p as { business_id: string }).business_id;
    const mm = metricsOf((p as { media: unknown }).media);
    const score = eng(mm);
    if (score <= 0) continue;
    const arr = postsByBiz.get(bid) ?? [];
    arr.push({
      platform: (p as { platform: string }).platform,
      url: (p as { url: string | null }).url ?? null,
      caption: String((p as { text?: string }).text ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      likes: mm?.likes,
      views: mm?.views,
      comments: mm?.comments,
      _eng: score,
    });
    postsByBiz.set(bid, arr);
  }
  for (const [bid, arr] of postsByBiz) {
    arr.sort((a, b) => b._eng - a._eng);
    postsByBiz.set(bid, arr.slice(0, 4));
  }

  // a sample of what each competitor sells + prices (dedup by item, prefer priced)
  const offersByBiz = new Map<string, { item: string; price: number | null }[]>();
  const seenOffer = new Map<string, Set<string>>();
  for (const o of offerRows ?? []) {
    const bid = (o as { business_id: string }).business_id;
    const item = String((o as { entity_text?: string }).entity_text ?? "").replace(/\s+/g, " ").trim();
    if (!item) continue;
    const key = item.toLowerCase();
    const seen = seenOffer.get(bid) ?? new Set<string>();
    if (seen.has(key)) continue;
    seen.add(key);
    seenOffer.set(bid, seen);
    const amt = Number((o as { pricing?: { amount?: number } }).pricing?.amount);
    const arr = offersByBiz.get(bid) ?? [];
    if (arr.length < 10) arr.push({ item, price: Number.isFinite(amt) && amt > 0 ? amt : null });
    offersByBiz.set(bid, arr);
  }
  // prefer priced items first within each business's sample
  for (const [bid, arr] of offersByBiz) {
    arr.sort((a, b) => Number(b.price != null) - Number(a.price != null));
    offersByBiz.set(bid, arr.slice(0, 8));
  }

  // best "go look" link per competitor (booking platform preferred over website)
  const identsByBiz = new Map<string, { platform: string; url: string }[]>();
  for (const r of idents ?? []) {
    const bid = (r as { business_id: string }).business_id;
    const arr = identsByBiz.get(bid) ?? [];
    arr.push({ platform: (r as { platform: string }).platform, url: (r as { url: string }).url });
    identsByBiz.set(bid, arr);
  }

  const cards: CompetitorCard[] = (edges ?? []).map((e) => {
    const bid = (e as { competitor_id: string }).competitor_id;
    const comp = (e as { competitor: { canonical_name?: string; website?: string; attributes?: { geo?: { lat: number; lng: number }; subtype?: string[] } } }).competitor ?? {};
    const price = priceById.get(bid);
    const rep = repById.get(bid);

    // price position vs you
    let vsYou: "higher" | "lower" | "similar" | null = null;
    let deltaPct: number | null = null;
    if (price?.avgPrice != null && you.avgPrice != null && you.avgPrice > 0) {
      deltaPct = Number((((price.avgPrice - you.avgPrice) / you.avgPrice) * 100).toFixed(0));
      vsYou = deltaPct > 5 ? "higher" : deltaPct < -5 ? "lower" : "similar";
    }

    // booking/website link
    const rows = identsByBiz.get(bid) ?? [];
    const booking = rows.find((r) => r.url && BOOKING_HOST.test(r.url));
    const linkUrl = booking?.url ?? comp.website ?? null;
    const link = linkUrl ? { url: linkUrl, kind: (booking ? "booking" : "website") as "booking" | "website" } : null;

    const topPosts = (postsByBiz.get(bid) ?? []).map(({ _eng, ...p }) => p);

    return {
      businessId: bid,
      name: comp.canonical_name ?? price?.name ?? "Competitor",
      relation: String((e as { relation?: string }).relation ?? "competitor"),
      distanceKm: haversineKm(targetGeo, comp.attributes?.geo),
      link,
      subtype: comp.attributes?.subtype ?? [],
      rating: rep?.rating != null ? { score: rep.rating, reviewCount: rep.reviewCount, source: rep.sources[0]?.source ?? "google" } : null,
      ratingSources: (rep?.sources ?? []).map((s) => ({ source: s.source, rating: s.rating, reviewCount: s.reviewCount })),
      price: { avg: price?.avgPrice ?? null, min: price?.minPrice ?? null, max: price?.maxPrice ?? null, items: price?.offers ?? 0, vsYou, deltaPct },
      recentChanges: changesByBiz.get(bid) ?? [],
      topPosts,
      offers: offersByBiz.get(bid) ?? [],
    };
  });

  // rank: those with a recent move first, then by rating, then by name
  cards.sort((a, b) => {
    const am = a.recentChanges.length ? 0 : 1;
    const bm = b.recentChanges.length ? 0 : 1;
    if (am !== bm) return am - bm;
    return (b.rating?.score ?? 0) - (a.rating?.score ?? 0);
  });

  return { you, cards };
}
