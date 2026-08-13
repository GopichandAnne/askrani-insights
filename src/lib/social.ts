import { createClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Per-competitor SOCIAL scorecard over time — engagement trend (this window vs the
 * prior one), the top-performing post, the format that's working, and follower
 * change. Content performance comes from content_item's stored engagement metrics
 * (deterministic, no LLM); follower history comes from goals.socialTimeline, which
 * the flyer job banks per scan. Everything is date-bounded so it sharpens with
 * history (and respects the plan's retention window via the caller's `days`).
 */

const DAY = 86400000;
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;
const hasVideo = (m: unknown) => Array.isArray(m) && m.some((x) => (x as { type?: string })?.type === "video");

export interface CompSocial {
  rival: string;
  posts: number;
  engagement: number;
  trendPct: number | null;       // vs the prior window
  topPost?: { caption: string; eng: number; url?: string; at?: string };
  topFormat?: "video" | "image" | null;
  followers?: number | null;
  followersDelta?: number | null; // vs ~7 days ago
}
export interface SocialTimelinePoint { date: string; followers?: number; source?: string }

export async function getCompetitorSocial(ws: WorkspaceRow, days: number): Promise<{ rows: CompSocial[]; at: string }> {
  const at = new Date().toISOString();
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.competitorIds.length) return { rows: [], at };

  const sinceMs = Date.now() - 2 * days * DAY; // pull two windows for the trend
  const { data: posts } = await supabase
    .from("content_item")
    .select("text, url, platform, published_at, observed_at, media, business:business_id(canonical_name)")
    .in("business_id", ids.competitorIds)
    .in("platform", ["instagram", "facebook", "tiktok", "youtube"])
    .order("observed_at", { ascending: false })
    .limit(1000);

  const winStart = Date.now() - days * DAY;
  const timeline = ((ws.goals as { socialTimeline?: Record<string, SocialTimelinePoint[]> } | undefined)?.socialTimeline) ?? {};

  const byRival = new Map<string, { thisEng: number; prevEng: number; posts: number; top?: { caption: string; eng: number; url?: string; at?: string }; vid: number; img: number }>();
  for (const p of posts ?? []) {
    const rival = (p as any).business?.canonical_name ?? "A rival";
    const date = ((p as any).published_at ?? (p as any).observed_at) as string | undefined;
    const t = date ? new Date(date).getTime() : NaN;
    if (isNaN(t) || t < sinceMs) continue;
    const eng = engOf(metricsOf((p as any).media));
    const b = byRival.get(rival) ?? { thisEng: 0, prevEng: 0, posts: 0, vid: 0, img: 0 };
    if (t >= winStart) {
      b.thisEng += eng; b.posts++;
      if (hasVideo((p as any).media)) b.vid += eng; else b.img += eng;
      const caption = String((p as any).text ?? "").replace(/\s+/g, " ").trim();
      if (!b.top || eng > b.top.eng) b.top = { caption: caption.slice(0, 120), eng, url: (p as any).url ?? undefined, at: date };
    } else { b.prevEng += eng; }
    byRival.set(rival, b);
  }

  const rows: CompSocial[] = [...byRival.entries()].map(([rival, b]) => {
    const pts = (timeline[rival] ?? []).filter((x) => x.followers != null).sort((a, z) => new Date(a.date).getTime() - new Date(z.date).getTime());
    const latest = pts[pts.length - 1];
    const weekAgo = [...pts].reverse().find((x) => new Date(latest?.date ?? 0).getTime() - new Date(x.date).getTime() >= 6 * DAY);
    return {
      rival,
      posts: b.posts,
      engagement: b.thisEng,
      trendPct: b.prevEng > 0 ? Math.round(((b.thisEng - b.prevEng) / b.prevEng) * 100) : null,
      topPost: b.top && b.top.eng > 0 ? b.top : undefined,
      topFormat: (b.vid === 0 && b.img === 0 ? null : b.vid >= b.img ? "video" : "image") as "video" | "image" | null,
      followers: latest?.followers ?? null,
      followersDelta: latest?.followers != null && weekAgo?.followers != null ? latest.followers - weekAgo.followers : null,
    };
  }).sort((a, z) => z.engagement - a.engagement);

  return { rows, at };
}
