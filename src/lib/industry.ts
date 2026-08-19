import { staleCached } from "@/lib/staleCache";
import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { collectApifyHashtag, hashtagActorConfigured } from "@/lib/providers/apify/platforms";

/**
 * The national INDUSTRY corpus — "best content getting traction in your industry"
 * across the country, discovery-first. We scrape the TOP posts under the
 * vertical's hashtags (the category's LANGUAGE, not a hand-picked account list),
 * so the best content — and the accounts behind it — EMERGE from engagement,
 * including creators an owner would never think to follow. The corpus is SHARED
 * per vertical (one restaurant pool serves every restaurant workspace) and
 * refreshed on demand (Apify hashtag scraping is cost-bearing, so it's gated and
 * never auto-runs). The synthesis reads that pool and turns it into formats the
 * owner can borrow.
 */

// The vertical's language: subtype-specific tags first (most relevant), then a
// couple of vertical base tags. Small on purpose — each tag is one paid scrape.
const VERTICAL_BASE: Record<string, string[]> = {
  restaurant: ["foodie", "foodreels"],
  salon: ["medspa", "aesthetics"],
  grocery: ["cooking", "mealprep"],
  smoke_vape: ["smokeshop", "vapelife"],
};
const SUBTYPE_TAGS: Record<string, string[]> = {
  // cuisines
  indian: ["indianfood", "indianrestaurant", "biryani"], pakistani: ["pakistanifood", "desifood"],
  bangladeshi: ["banglafood"], nepali: ["nepalifood"], desi: ["desifood"],
  mexican: ["mexicanfood", "tacos"], italian: ["italianfood", "pasta"], chinese: ["chinesefood"],
  korean: ["koreanfood"], japanese: ["sushi", "japanesefood"], thai: ["thaifood"],
  vietnamese: ["pho", "vietnamesefood"], mediterranean: ["mediterraneanfood"], greek: ["greekfood"],
  middle_eastern: ["shawarma", "middleeasternfood"], caribbean: ["caribbeanfood"], ethiopian: ["ethiopianfood"],
  american: ["burger", "comfortfood"], bbq: ["bbq", "barbecue"], pizza: ["pizza"], vegan: ["veganfood"],
  // beauty / med-spa service lines
  medspa: ["medspa", "aesthetics"], injectables: ["botox", "lipfiller", "tox"],
  laser_body: ["laserhairremoval", "coolsculpting"], skincare: ["hydrafacial", "facial", "skincareroutine"],
  lash_brow: ["lashextensions", "microblading"], nails: ["nailart", "nails"],
  hair: ["hairsalon", "balayage"], waxing: ["waxing"], wellness: ["wellness", "ivtherapy"],
};

export function industryHashtags(vertical: string, subtype: string[] = [], max = 5): string[] {
  const out: string[] = [];
  for (const s of subtype) for (const t of SUBTYPE_TAGS[s] ?? []) if (!out.includes(t)) out.push(t);
  for (const t of VERTICAL_BASE[vertical] ?? ["smallbusiness"]) if (!out.includes(t)) out.push(t);
  if (!out.length) out.push("smallbusiness");
  return out.slice(0, max);
}

const eng = (p: { views?: number; likes?: number; comments?: number }) => (p.views || 0) + (p.likes || 0) * 3 + (p.comments || 0) * 5;

export interface RefreshResult { activated: boolean; tags: string[]; scraped: number; costUsd: number }

/** Scrape + upsert the national corpus for a vertical/subtype. Cost-bearing —
 *  only called from the gated /api/industry/refresh endpoint, never on render. */
export async function refreshIndustryCorpus(
  vertical: string, subtype: string[] = [], opts: { limitPerTag?: number; maxTags?: number } = {},
): Promise<RefreshResult> {
  if (!hashtagActorConfigured()) return { activated: false, tags: [], scraped: 0, costUsd: 0 };
  const tags = industryHashtags(vertical, subtype, opts.maxTags ?? 5);
  const svc = createServiceClient();
  let scraped = 0, costUsd = 0;
  for (const tag of tags) {
    const { items, costUsd: c } = await collectApifyHashtag(tag, { limit: opts.limitPerTag ?? 30 });
    costUsd += c;
    for (const it of items) {
      const row = {
        vertical, subtype, platform: "instagram", hashtag: tag,
        external_ref: it.externalRef, url: it.url ?? null, author_handle: it.authorHandle ?? null,
        caption: it.caption.slice(0, 2000), likes: it.likes ?? null, comments: it.comments ?? null,
        views: it.views ?? null, eng: eng(it), published_at: it.publishedAt ?? null, scraped_at: new Date().toISOString(),
      };
      const { error } = await svc.from("industry_post").upsert(row, { onConflict: "platform,external_ref" });
      if (!error) scraped++;
    }
  }
  return { activated: true, tags, scraped, costUsd: Number(costUsd.toFixed(4)) };
}

export interface IndustryBestPost {
  authorHandle?: string; url?: string; caption: string;
  likes?: number; views?: number; comments?: number;
  format: string; whyItWorks: string; yourVersion: string;
}
export interface IndustryBest {
  summary: string;
  best: IndustryBestPost[];
  corpusSize: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
// Scraped Instagram captions carry lone/unpaired UTF-16 surrogates (broken
// emoji) that serialize to INVALID JSON in the LLM request body (Anthropic 400
// "no low surrogate in string"). toWellFormed() replaces them with U+FFFD;
// fall back to a regex strip on older runtimes.
const sanitize = (s?: string): string => {
  const v = String(s ?? "");
  const tw = (v as unknown as { toWellFormed?: () => string }).toWellFormed;
  return typeof tw === "function"
    ? tw.call(v)
    : v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, "");
};

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", description: "2–3 plain sentences: what kind of content is winning in this industry nationally right now and what the owner should make." },
    best: {
      type: "array", maxItems: 8,
      description: "The best posts to learn from — reference each by its [n] index. Pick the highest-signal, most replicable ones; skip weak ones.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          index: { type: "integer", description: "the [n] index of the post" },
          format: { type: "string", description: "the format/angle in a few words (e.g. 'ASMR plating', 'day-in-the-life', 'before/after', 'recipe hook')" },
          whyItWorks: { type: "string", description: "≤15 words on why it lands (grounded in the engagement/caption)" },
          yourVersion: { type: "string", description: "a concrete post idea THIS owner could shoot this week, adapted to their business" },
        },
        required: ["index", "format", "whyItWorks", "yourVersion"],
      },
    },
  },
  required: ["summary", "best"],
};

const SYSTEM =
  "You are Ask Rani, a content coach. From the best-performing NATIONAL posts in this owner's industry (surfaced by engagement under category hashtags — so they include creators the owner may not follow), pick the most replicable formats and, for each, write a concrete 'your version' adapted to THIS local business. Ground every pick in the provided posts; never invent engagement numbers. Plain English.";

const empty = (at: string, failed = false): IndustryBest => ({ summary: "", best: [], corpusSize: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateIndustryBest(ws: WorkspaceRow, _db?: RlsClient): Promise<IndustryBest> {
  const at = new Date().toISOString();
  const svc = createServiceClient();
  // corpus is shared/global → always read with the service client (RLS-locked).
  let rows: any[] = [];
  try {
    const { data } = await svc
      .from("industry_post")
      .select("author_handle, url, caption, likes, comments, views, eng, subtype")
      .eq("vertical", ws.vertical ?? "restaurant")
      .order("eng", { ascending: false })
      .limit(120);
    rows = data ?? [];
  } catch {
    return empty(at); // table not created yet (pre-migration) — behave as "not activated"
  }
  if (!rows.length) return empty(at);

  // Prefer posts matching the owner's subtype, then fill with the rest.
  const wsSub: string[] = ((ws as any).subtype as string[]) ?? [];
  const match = (r: any) => (wsSub.length ? (Array.isArray(r.subtype) && r.subtype.some((s: string) => wsSub.includes(s)) ? 0 : 1) : 0);
  const ranked = rows
    .map((r) => ({ authorHandle: sanitize(r.author_handle) || undefined, url: r.url ?? undefined, caption: sanitize(r.caption).replace(/\s+/g, " ").trim(), likes: r.likes ?? undefined, comments: r.comments ?? undefined, views: r.views ?? undefined, eng: Number(r.eng ?? 0), _m: match(r) }))
    .filter((r) => r.caption.length > 6)
    .sort((a, b) => a._m - b._m || b.eng - a.eng)
    .slice(0, 24);

  if (!isLlmConfigured() || ranked.length < 3) return { summary: "", best: [], corpusSize: rows.length, at, empty: true };

  const list = ranked.map((p, i) => `[${i}] @${p.authorHandle ?? "creator"} — ${p.views ? `${p.views} views, ` : ""}${p.likes ? `${p.likes} likes, ` : ""}${p.comments ? `${p.comments} comments` : ""} :: ${p.caption.slice(0, 200)}`).join("\n");
  try {
    const { data } = await getLlm().callStructured<{ summary: string; best: { index: number; format: string; whyItWorks: string; yourVersion: string }[] }>({
      system: SYSTEM,
      text: sanitize(`Business: "${ws.name}" (vertical: ${ws.vertical}${wsSub.length ? `, ${wsSub.join("/")}` : ""}).\n\nTOP NATIONAL INDUSTRY POSTS BY ENGAGEMENT:\n${list}\n\nPick the best formats to borrow.`),
      schema: SCHEMA, tier: "extract", maxTokens: 1800,
    });
    const best: IndustryBestPost[] = (data.best ?? [])
      .map((b) => {
        const p = ranked[b.index];
        if (!p) return null;
        return { authorHandle: p.authorHandle, url: p.url, caption: p.caption.slice(0, 180), likes: p.likes, views: p.views, comments: p.comments, format: strip(b.format), whyItWorks: strip(b.whyItWorks), yourVersion: strip(b.yourVersion) } as IndustryBestPost;
      })
      .filter((b): b is IndustryBestPost => !!b && !!b.yourVersion)
      .slice(0, 8);
    return { summary: strip(data.summary), best, corpusSize: rows.length, at };
  } catch (e) {
    if (process.env.INDUSTRY_DEBUG) console.error("generateIndustryBest error:", (e as Error).message);
    return empty(at, true);
  }
}

/** Cached national best-content read — served instantly, regenerated in the
 *  background when stale. Never overwrites a good cache with an empty (not-yet-
 *  activated) read. */
export function getOrMakeIndustryBest(ws: WorkspaceRow, maxAgeHours = 24): Promise<IndustryBest> {
  return staleCached(ws, "industryBest", maxAgeHours, () => generateIndustryBest(ws), {
    isValid: (c) => !c.failed,
    keep: (fresh, cached) => !!fresh.empty && !!cached && !cached.empty,
  });
}
