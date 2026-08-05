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

export interface CompetitorCard {
  businessId: string;
  name: string;
  relation: string;
  distanceKm: number | null;
  link: { url: string; kind: "booking" | "website" } | null;
  subtype: string[];
  rating: { score: number; reviewCount: number | null; source: string } | null;
  price: { avg: number | null; items: number; vsYou: "higher" | "lower" | "similar" | null; deltaPct: number | null };
  recentChange: { type: string; summary: string; at: string | null } | null;
  topPost: { platform: string; url: string | null; caption: string; likes?: number; views?: number; comments?: number } | null;
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

  const [{ data: edges }, { data: target }, { data: events }, { data: posts }, { data: idents }] =
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
        .limit(400),
      supabase
        .from("content_item")
        .select("business_id, platform, text, media, url, observed_at")
        .in("business_id", compIds)
        .in("platform", [...SOCIAL])
        .order("observed_at", { ascending: false })
        .limit(1500),
      supabase.from("external_identity").select("business_id, platform, url").in("business_id", compIds),
    ]);

  const targetGeo = (target as { attributes?: { geo?: { lat: number; lng: number } } } | null)?.attributes?.geo;

  // latest change per competitor
  const changeByBiz = new Map<string, { type: string; summary: string; at: string | null }>();
  for (const e of events ?? []) {
    const bid = (e as { business_id: string }).business_id;
    if (!changeByBiz.has(bid)) {
      changeByBiz.set(bid, {
        type: String((e as { event_type: string }).event_type),
        summary: (e as { summary: string }).summary ?? "",
        at: (e as { time_start: string | null }).time_start ?? null,
      });
    }
  }

  // best-performing recent post per competitor
  const topByBiz = new Map<string, CompetitorCard["topPost"] & { _eng: number }>();
  for (const p of posts ?? []) {
    const bid = (p as { business_id: string }).business_id;
    const mm = metricsOf((p as { media: unknown }).media);
    const score = eng(mm);
    if (score <= 0) continue;
    const cur = topByBiz.get(bid);
    if (!cur || score > cur._eng) {
      topByBiz.set(bid, {
        platform: (p as { platform: string }).platform,
        url: (p as { url: string | null }).url ?? null,
        caption: String((p as { text?: string }).text ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
        likes: mm?.likes,
        views: mm?.views,
        comments: mm?.comments,
        _eng: score,
      });
    }
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

    const top = topByBiz.get(bid);
    const topPost = top ? { platform: top.platform, url: top.url, caption: top.caption, likes: top.likes, views: top.views, comments: top.comments } : null;

    return {
      businessId: bid,
      name: comp.canonical_name ?? price?.name ?? "Competitor",
      relation: String((e as { relation?: string }).relation ?? "competitor"),
      distanceKm: haversineKm(targetGeo, comp.attributes?.geo),
      link,
      subtype: comp.attributes?.subtype ?? [],
      rating: rep?.rating != null ? { score: rep.rating, reviewCount: rep.reviewCount, source: rep.sources[0]?.source ?? "google" } : null,
      price: { avg: price?.avgPrice ?? null, items: price?.offers ?? 0, vsYou, deltaPct },
      recentChange: changeByBiz.get(bid) ?? null,
      topPost,
    };
  });

  // rank: those with a recent move first, then by rating, then by name
  cards.sort((a, b) => {
    const am = a.recentChange ? 0 : 1;
    const bm = b.recentChange ? 0 : 1;
    if (am !== bm) return am - bm;
    return (b.rating?.score ?? 0) - (a.rating?.score ?? 0);
  });

  return { you, cards };
}
