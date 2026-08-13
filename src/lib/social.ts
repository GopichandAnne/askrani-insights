import { createClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Unified per-competitor SIGNAL scorecard over time — one consistent view that
 * merges three dated sources: per-channel FOLLOWERS (goals.socialTimeline, banked
 * per scan via the profile-stats scrape), REVIEWS (market_snapshot's daily
 * rating/review_count), and content ENGAGEMENT + top post/format (content_item's
 * stored per-post metrics). All date-bounded, so it sharpens with history.
 */

const DAY = 86400000;
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;
const hasVideo = (m: unknown) => Array.isArray(m) && m.some((x) => (x as { type?: string })?.type === "video");

export interface ChannelFollowers { channel: string; followers: number; delta: number | null }
export interface CompSocial {
  rival: string;
  posts: number;
  engagement: number;
  trendPct: number | null;
  topPost?: { caption: string; eng: number; url?: string; at?: string };
  topFormat?: "video" | "image" | null;
  channels: ChannelFollowers[];
  reviews?: { count: number; countDelta: number | null; rating: number | null; ratingDelta: number | null };
}
export interface SocialTimelinePoint { date: string; channel: string; followers?: number }

export async function getCompetitorSocial(ws: WorkspaceRow, days: number): Promise<{ rows: CompSocial[]; at: string }> {
  const at = new Date().toISOString();
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.competitorIds.length) return { rows: [], at };

  const sinceMs = Date.now() - 2 * days * DAY;
  const sinceDate = new Date(sinceMs).toISOString().slice(0, 10);
  const [{ data: biz }, { data: posts }, { data: snaps }] = await Promise.all([
    supabase.from("business").select("id, canonical_name").in("id", ids.competitorIds),
    supabase.from("content_item").select("text, url, platform, published_at, observed_at, media, business:business_id(canonical_name)").in("business_id", ids.competitorIds).in("platform", ["instagram", "facebook", "tiktok", "youtube"]).order("observed_at", { ascending: false }).limit(1000),
    supabase.from("market_snapshot").select("business_id, captured_on, rating, review_count").in("business_id", ids.competitorIds).gte("captured_on", sinceDate).order("captured_on", { ascending: true }),
  ]);

  const nameById = new Map((biz ?? []).map((b: any) => [b.id as string, b.canonical_name as string]));
  const winStart = Date.now() - days * DAY;
  const timeline = ((ws.goals as { socialTimeline?: Record<string, SocialTimelinePoint[]> } | undefined)?.socialTimeline) ?? {};

  // engagement + top post/format per rival (from content_item)
  const eng = new Map<string, { thisEng: number; prevEng: number; posts: number; top?: { caption: string; eng: number; url?: string; at?: string }; vid: number; img: number }>();
  for (const p of posts ?? []) {
    const rival = (p as any).business?.canonical_name ?? "A rival";
    const date = ((p as any).published_at ?? (p as any).observed_at) as string | undefined;
    const t = date ? new Date(date).getTime() : NaN;
    if (isNaN(t) || t < sinceMs) continue;
    const e = engOf(metricsOf((p as any).media));
    const b = eng.get(rival) ?? { thisEng: 0, prevEng: 0, posts: 0, vid: 0, img: 0 };
    if (t >= winStart) {
      b.thisEng += e; b.posts++;
      if (hasVideo((p as any).media)) b.vid += e; else b.img += e;
      const caption = String((p as any).text ?? "").replace(/\s+/g, " ").trim();
      if (!b.top || e > b.top.eng) b.top = { caption: caption.slice(0, 120), eng: e, url: (p as any).url ?? undefined, at: date };
    } else b.prevEng += e;
    eng.set(rival, b);
  }

  // reviews per rival (from market_snapshot) — count growth + rating shift over window
  const rev = new Map<string, { count: number; countDelta: number | null; rating: number | null; ratingDelta: number | null }>();
  const snapByName = new Map<string, { captured_on: string; rating: number | null; review_count: number | null }[]>();
  for (const s of snaps ?? []) {
    const name = nameById.get((s as any).business_id as string); if (!name) continue;
    (snapByName.get(name) ?? snapByName.set(name, []).get(name)!).push(s as any);
  }
  for (const [name, arr] of snapByName) {
    const inWin = arr.filter((s) => new Date(s.captured_on).getTime() >= winStart);
    const latest = arr[arr.length - 1];
    const firstInWin = inWin[0] ?? arr[0];
    if (!latest) continue;
    rev.set(name, {
      count: latest.review_count ?? 0,
      countDelta: latest.review_count != null && firstInWin?.review_count != null ? latest.review_count - firstInWin.review_count : null,
      rating: latest.rating ?? null,
      ratingDelta: latest.rating != null && firstInWin?.rating != null ? Number((latest.rating - firstInWin.rating).toFixed(1)) : null,
    });
  }

  // per-channel followers per rival (from socialTimeline)
  const channelsOf = (rival: string): ChannelFollowers[] => {
    const pts = (timeline[rival] ?? []).filter((p) => p.followers != null && p.channel);
    const byChannel = new Map<string, SocialTimelinePoint[]>();
    for (const p of pts) (byChannel.get(p.channel) ?? byChannel.set(p.channel, []).get(p.channel)!).push(p);
    const out: ChannelFollowers[] = [];
    for (const [channel, list] of byChannel) {
      list.sort((a, z) => new Date(a.date).getTime() - new Date(z.date).getTime());
      const latest = list[list.length - 1];
      const prior = [...list].reverse().find((x) => new Date(latest.date).getTime() - new Date(x.date).getTime() >= 6 * DAY);
      out.push({ channel, followers: latest.followers!, delta: latest.followers != null && prior?.followers != null ? latest.followers - prior.followers : null });
    }
    return out.sort((a, z) => z.followers - a.followers);
  };

  const names = new Set<string>([...eng.keys(), ...rev.keys(), ...Object.keys(timeline)]);
  const rows: CompSocial[] = [...names].map((rival) => {
    const b = eng.get(rival);
    return {
      rival,
      posts: b?.posts ?? 0,
      engagement: b?.thisEng ?? 0,
      trendPct: b && b.prevEng > 0 ? Math.round(((b.thisEng - b.prevEng) / b.prevEng) * 100) : null,
      topPost: b?.top && b.top.eng > 0 ? b.top : undefined,
      topFormat: (!b || (b.vid === 0 && b.img === 0) ? null : b.vid >= b.img ? "video" : "image") as "video" | "image" | null,
      channels: channelsOf(rival),
      reviews: rev.get(rival),
    };
  }).sort((a, z) => z.engagement - a.engagement || (z.channels[0]?.followers ?? 0) - (a.channels[0]?.followers ?? 0));

  return { rows, at };
}
