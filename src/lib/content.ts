import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * The "Content" layer — content-CRAFT intelligence, one level below the
 * theme-level "Trending near you". From the social posts we already collect for
 * the workspace's rivals it builds three things:
 *   • a SWIPE FILE — the actual best-performing rival posts, each with the format
 *     that made it work and a ready "your version" the owner can post;
 *   • a COLLAB / INFLUENCER RADAR — the @accounts rivals tag/partner with, so the
 *     owner knows who to work with locally;
 *   • the HASHTAGS rivals lean on.
 * All from existing data (no new scraping). Cached on workspace.goals.content.
 */

const SOCIAL = ["instagram", "facebook", "tiktok", "youtube"];

export interface SwipePost {
  business: string;
  platform: string;
  caption: string;
  url?: string;
  views?: number; likes?: number; comments?: number;
  format: string;       // LLM: the content format/angle
  whyItWorks: string;   // LLM
  yourVersion: string;  // LLM: a concrete post idea for THIS owner
}
export interface CollabItem {
  handle: string;
  whoTheyAre: string;   // LLM: influencer / food blogger / venue partner …
  why: string;          // LLM: why worth reaching out
  mentions: number;     // how many rival posts tagged them
  byRivals: string[];   // which rivals
  url?: string;         // a sample post that tagged them
}
export interface ContentReport {
  summary: string;
  swipe: SwipePost[];
  collabs: CollabItem[];
  hashtags: { tag: string; count: number }[];
  postsSeen: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;

// @handle / #tag extraction from captions. Handles are 2–30 chars; skip bare "@".
const MENTION_RE = /(?:^|[^\w@])@([a-z0-9._]{2,30})\b/gi;
const HASHTAG_RE = /#([a-z0-9_]{2,40})\b/gi;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "2–3 plain sentences: the content play working for rivals right now and what the owner should make." },
    swipe: {
      type: "array", maxItems: 8,
      description: "The best rival posts to learn from. Reference each by its [n] index from the list. Skip weak ones — fewer, higher-signal is better.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          index: { type: "integer", description: "the [n] index of the post" },
          format: { type: "string", description: "the format/angle in a few words (e.g. 'before/after reel', 'chef POV cooking', 'customer testimonial', 'limited-time drop')" },
          whyItWorks: { type: "string", description: "≤15 words on why it landed (grounded in the engagement/caption)" },
          yourVersion: { type: "string", description: "a concrete post idea THIS owner could shoot this week, in their own words" },
        },
        required: ["index", "format", "whyItWorks", "yourVersion"],
      },
    },
    collabs: {
      type: "array", maxItems: 6,
      description: "From the tagged @accounts: the ones worth THIS owner collaborating with (local influencers/creators/partners). Skip the rivals' own brand accounts and big national chains.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          handle: { type: "string", description: "the @handle exactly as given (no @)" },
          whoTheyAre: { type: "string", description: "best guess at who they are (food blogger, local influencer, venue, supplier…)" },
          why: { type: "string", description: "≤14 words on why worth reaching out" },
        },
        required: ["handle", "whoTheyAre", "why"],
      },
    },
  },
  required: ["summary", "swipe", "collabs"],
};

const SYSTEM =
  "You are Ask Rani, a content coach for a busy local-business owner. Work ONLY from the rivals' real posts (with engagement numbers) and the tagged accounts given. Pick the posts most worth copying and name the format that made each work; write a concrete 'your version' the owner could actually shoot. From the tagged @accounts, surface the ones worth collaborating with locally (not the rivals' own brand pages, not giant national chains). Plain English, specific, never invent engagement numbers.";

const empty = (at: string, failed = false): ContentReport => ({ summary: "", swipe: [], collabs: [], hashtags: [], postsSeen: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateContent(ws: WorkspaceRow, days = 90, db?: RlsClient): Promise<ContentReport> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.competitorIds.length) return empty(at);

  const { data: posts } = await supabase
    .from("content_item")
    .select("text, platform, media, url, published_at, observed_at, business:business_id(canonical_name)")
    .in("business_id", ids.competitorIds)
    .in("platform", SOCIAL)
    .order("observed_at", { ascending: false })
    .limit(500);

  const all = (posts ?? []).map((p) => {
    const mm = metricsOf((p as { media: unknown }).media);
    return {
      business: (p as { business?: { canonical_name?: string } }).business?.canonical_name ?? "A rival",
      platform: (p as { platform: string }).platform,
      caption: String((p as { text?: string }).text ?? "").replace(/\s+/g, " ").trim(),
      url: (p as { url?: string }).url ?? undefined,
      views: mm?.views, likes: mm?.likes, comments: mm?.comments,
      eng: engOf(mm),
    };
  });

  // ── collab radar: @mentions across all captions (deterministic) ──
  const mentionAcc = new Map<string, { count: number; rivals: Set<string>; url?: string }>();
  for (const p of all) {
    const seen = new Set<string>();
    for (const m of p.caption.matchAll(MENTION_RE)) {
      const h = m[1].toLowerCase().replace(/\.+$/, "");
      if (h.length < 2 || seen.has(h)) continue;
      seen.add(h);
      const acc = mentionAcc.get(h) ?? { count: 0, rivals: new Set<string>(), url: p.url };
      acc.count++; acc.rivals.add(p.business);
      if (!acc.url) acc.url = p.url;
      mentionAcc.set(h, acc);
    }
  }
  const mentions = [...mentionAcc.entries()]
    .map(([handle, v]) => ({ handle, count: v.count, byRivals: [...v.rivals], url: v.url }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ── hashtags rivals use (deterministic, shown directly) ──
  const tagAcc = new Map<string, number>();
  for (const p of all) for (const m of p.caption.matchAll(HASHTAG_RE)) {
    const t = m[1].toLowerCase();
    tagAcc.set(t, (tagAcc.get(t) ?? 0) + 1);
  }
  const hashtags = [...tagAcc.entries()].map(([tag, count]) => ({ tag, count })).filter((h) => h.count > 1).sort((a, b) => b.count - a.count).slice(0, 15);

  // top posts by engagement — the swipe-file candidates
  const ranked = all.filter((p) => p.caption.length > 4).sort((a, b) => b.eng - a.eng).slice(0, 24);
  if (ranked.length < 3) return empty(at);
  if (!isLlmConfigured()) return { summary: "", swipe: [], collabs: [], hashtags, postsSeen: all.length, at, empty: true };

  const postList = ranked.map((p, i) => `[${i}] ${p.business} on ${p.platform} — ${p.views ? `${p.views} views, ` : ""}${p.likes ? `${p.likes} likes, ` : ""}${p.comments ? `${p.comments} comments` : ""} :: ${p.caption.slice(0, 200)}`).join("\n");
  const mentionList = mentions.map((m) => `@${m.handle} (tagged ${m.count}× by ${m.byRivals.join(", ")})`).join("\n") || "(none found)";

  try {
    const { data } = await getLlm().callStructured<{
      summary: string;
      swipe: { index: number; format: string; whyItWorks: string; yourVersion: string }[];
      collabs: { handle: string; whoTheyAre: string; why: string }[];
    }>({
      system: SYSTEM,
      text: `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\nTOP RIVAL POSTS BY ENGAGEMENT:\n${postList}\n\nTAGGED @ACCOUNTS (collab candidates):\n${mentionList}\n\nBuild the swipe file + collab radar.`,
      schema: SCHEMA,
      tier: "extract",
      maxTokens: 1800,
    });

    const swipe: SwipePost[] = (data.swipe ?? [])
      .map((s) => {
        const p = ranked[s.index];
        if (!p) return null;
        return {
          business: p.business, platform: p.platform, caption: p.caption.slice(0, 180), url: p.url,
          views: p.views, likes: p.likes, comments: p.comments,
          format: strip(s.format), whyItWorks: strip(s.whyItWorks), yourVersion: strip(s.yourVersion),
        } as SwipePost;
      })
      .filter((s): s is SwipePost => !!s && !!s.yourVersion)
      .slice(0, 8);

    const collabs: CollabItem[] = (data.collabs ?? [])
      .map((c) => {
        const handle = String(c.handle ?? "").replace(/^@/, "").toLowerCase().trim();
        const rec = mentionAcc.get(handle);
        return {
          handle, whoTheyAre: strip(c.whoTheyAre), why: strip(c.why),
          mentions: rec?.count ?? 0, byRivals: rec ? [...rec.rivals] : [], url: rec?.url,
        } as CollabItem;
      })
      .filter((c) => c.handle)
      .slice(0, 6);

    return { summary: strip(data.summary), swipe, collabs, hashtags, postsSeen: all.length, at };
  } catch {
    return empty(at, true);
  }
}

/** Non-empty when we produced a swipe file or collab radar (warm-retry predicate). */
export function contentIsGood(c: ContentReport): boolean {
  return !!(c.swipe.length || c.collabs.length || c.empty);
}

/** Cached content report (regenerated when older than maxAgeHours). */
export async function getOrMakeContent(ws: WorkspaceRow, maxAgeHours = 12): Promise<ContentReport> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as { content?: ContentReport } | null)?.content;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && !cached.failed) return cached;

  const fresh = await generateContent(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), content: fresh } }).eq("id", ws.id);
  return fresh;
}
