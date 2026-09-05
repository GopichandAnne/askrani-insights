import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { upcomingOccasions } from "@/lib/occasions";

/**
 * "Post about what you sell" — the offerings content engine. Every other content
 * surface points OUTWARD at rivals (content.ts = rival swipe file, industry.ts =
 * national best, draft.ts = one caption for one move). This one points INWARD:
 * it takes the business's OWN offerings (the `offer` rows the crawler already
 * extracts — dishes, weekly deals, services) and produces a ready-to-post content
 * PLAN — specific ideas, each with a caption, hashtags, format, and WHEN to post —
 * grounded strictly in what the business actually sells. Cached on
 * workspace.goals.contentPlan. Business-mode only (an area workspace has no "you").
 */

export type ContentType = "promotional" | "educational" | "seasonal" | "behind_the_scenes" | "social_proof" | "spotlight";
export type ContentFormat = "reel" | "photo" | "carousel" | "story";
const TYPES: ContentType[] = ["promotional", "educational", "seasonal", "behind_the_scenes", "social_proof", "spotlight"];
const FORMATS: ContentFormat[] = ["reel", "photo", "carousel", "story"];

export interface ContentIdea {
  offering: string;        // the REAL offering it's about (grounded in the offer list)
  type: ContentType;
  hook: string;            // the one-line idea / angle
  caption: string;         // ready-to-post copy
  hashtags: string[];
  format: ContentFormat;
  timing: string;          // when to post (an occasion, day, or season)
  cta: string;             // the ask (order, book, visit, DM…)
}
export interface ContentPlan {
  summary: string;
  ideas: ContentIdea[];
  offeringsSeen: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

// Trim any tool-XML bleed the model occasionally emits mid-string (same defense
// the winning/demand layers use).
const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
const normName = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const cleanTag = (t: string) => strip(t).replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");
const cityFromAddress = (addr?: string): string => {
  // "123 Main St, Austin, TX 78701" → "Austin"
  const parts = String(addr ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2].replace(/\b[A-Z]{2}\b.*$/, "").trim() || parts[parts.length - 2] : "";
};

// Recover a model that renders the ideas array as an <item>…</item> string.
type Raw = { offering?: string; type?: string; hook?: string; caption?: string; hashtags?: unknown; format?: string; timing?: string; cta?: string };
function parseTaggedItems(s: string): Raw[] {
  const normalized = s.replace(/<parameter\s+name="([^"]+)">/gi, (_m, t) => `<${t}>`);
  const chunks = normalized.includes("<item>") ? normalized.split(/<item>/i) : normalized.split(/(?=<offering>)/i);
  const get = (b: string, tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|<[a-z/]|$)`, "i").exec(b);
    return m ? m[1].trim() : "";
  };
  const out: Raw[] = [];
  for (const b of chunks) {
    const offering = get(b, "offering");
    const caption = get(b, "caption");
    if (!offering || !caption) continue;
    out.push({ offering, caption, type: get(b, "type"), hook: get(b, "hook"), format: get(b, "format"), timing: get(b, "timing"), cta: get(b, "cta"), hashtags: get(b, "hashtags") });
  }
  return out;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", description: "ONE short sentence — the through-line of this week's content plan for the owner." },
    ideas: {
      type: "array", maxItems: 10,
      description: "Ready-to-post ideas, each grounded in ONE real offering from the list. Strongest/most-timely first. Mix the types — do NOT make them all promotional.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          offering: { type: "string", description: "the exact real offering this post is about, from the OFFERINGS list (a dish, a weekly deal, a service). Never invent one." },
          type: { type: "string", enum: TYPES, description: "promotional (a real deal/price), educational (how it's made/used/what to know), seasonal (tie to an occasion), behind_the_scenes, social_proof (a review/regular), spotlight (feature one item)" },
          hook: { type: "string", description: "≤12 words — the angle/idea in one line" },
          caption: { type: "string", description: "ready-to-paste caption in a warm, local, on-brand voice: 1–3 short sentences + the CTA. Reference the real offering (and its price only if given). No fabricated claims." },
          hashtags: { type: "array", maxItems: 6, items: { type: "string" }, description: "3–6 relevant hashtags (no # prefix), include the city/neighborhood where natural" },
          format: { type: "string", enum: FORMATS, description: "reel (process/motion), photo, carousel (multi-image/steps), story (quick/time-boxed)" },
          timing: { type: "string", description: "≤10 words — when to post it: an upcoming occasion from the list, a day of week, or a season" },
          cta: { type: "string", description: "≤8 words — the ask: order online, book now, visit us, DM to reserve…" },
        },
        required: ["offering", "type", "hook", "caption", "hashtags", "format", "timing", "cta"],
      },
    },
  },
  required: ["summary", "ideas"],
};

const SYSTEM =
  "You are Ask Rani, the social-media manager for a LOCAL business. Build a content PLAN of posts the owner can publish this week, each grounded in ONE of the business's REAL offerings from the list provided. " +
  "HARD RULES: (1) only use offerings from the list — never invent a dish, product, service, or price; reference a price only if it's given. (2) Mix the content TYPES — a good plan is mostly educational / behind-the-scenes / seasonal / social-proof with only a little hard promotion; never make them all 'buy now'. (3) Tie `timing` to a real upcoming occasion from the list when one fits, otherwise a sensible day or season. (4) Captions must be ready to paste: warm, specific, local, 1–3 short sentences plus the CTA — the kind of thing this owner would actually post. Keep the summary to one sentence. Fill the `ideas` array (aim for 6–9).";

const empty = (at: string, offeringsSeen = 0, failed = false): ContentPlan => ({ summary: "", ideas: [], offeringsSeen, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateContentPlan(ws: WorkspaceRow, db?: RlsClient): Promise<ContentPlan> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.targetId) return empty(at); // area-mode / no "you" — nothing of your own to post about

  const [{ data: offers }, { data: biz }] = await Promise.all([
    supabase.from("offer").select("entity_text, pricing").eq("business_id", ids.targetId).order("observed_at", { ascending: false }).limit(400),
    supabase.from("business").select("canonical_name, attributes").eq("id", ids.targetId).maybeSingle(),
  ]);

  // Distinct offerings (most recent first), each with a price if we have one.
  const seen = new Set<string>();
  const offeringLines: string[] = [];
  for (const o of offers ?? []) {
    const name = strip(String((o as any).entity_text ?? ""));
    const key = normName(name);
    if (!name || key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    const amt = Number((o as any).pricing?.amount);
    offeringLines.push(Number.isFinite(amt) && amt > 0 ? `${name} — $${amt.toFixed(2)}` : name);
    if (offeringLines.length >= 40) break;
  }
  if (!offeringLines.length) return empty(at, 0); // no menu/services extracted yet — honest gap, don't fabricate
  if (!isLlmConfigured()) return empty(at, offeringLines.length);

  // Optional enrichment from already-cached pillars (best-effort; may be absent on
  // a first warm run — the plan grounds on the offerings above regardless).
  const goals = (ws.goals as Record<string, any> | undefined) ?? {};
  const winningNames: string[] = Array.isArray(goals.winning?.items) ? goals.winning.items.map((w: any) => strip(w?.name)).filter(Boolean).slice(0, 8) : [];
  const myDeals: string[] = Array.isArray(goals.myDeals?.deals) ? goals.myDeals.deals.map((d: any) => strip(d?.deal)).filter(Boolean).slice(0, 6) : [];
  const city = cityFromAddress((biz as any)?.attributes?.address as string | undefined);
  const occasions = upcomingOccasions(ws.vertical, new Date(), 45, 4);

  const prompt =
    `Business: "${ws.name}"${city ? ` in ${city}` : ""} (vertical: ${ws.vertical}).\n\n` +
    `THE BUSINESS'S REAL OFFERINGS (ground every post in these — never invent):\n${offeringLines.join("\n")}\n\n` +
    (winningNames.length ? `OFFERINGS WITH MOMENTUM (worth featuring): ${winningNames.join(", ")}\n\n` : "") +
    (myDeals.length ? `DEALS THEY'RE ALREADY RUNNING (don't duplicate; build around them): ${myDeals.join("; ")}\n\n` : "") +
    (occasions.length ? `UPCOMING OCCASIONS (use for timing where they fit):\n${occasions.map((o) => `• ${o.name} in ${o.inDays}d — ${o.note}`).join("\n")}\n\n` : "") +
    `Build the content plan (fill the ideas array).`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ summary: string; ideas: Raw[] | string }>({
        system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 2600,
      });
      let rows: Raw[] = [];
      let summaryStr = strip(data.summary);
      if (Array.isArray(data.ideas)) {
        rows = data.ideas;
      } else if (typeof data.ideas === "string") {
        try {
          const p = JSON.parse(data.ideas);
          if (Array.isArray(p?.ideas)) { rows = p.ideas; summaryStr = summaryStr || strip(p.summary); }
          else if (Array.isArray(p)) rows = p;
        } catch { /* not JSON */ }
        if (!rows.length) rows = parseTaggedItems(data.ideas);
      }
      const ideas: ContentIdea[] = rows
        .map((r) => ({
          offering: strip(r.offering),
          type: (TYPES.includes(r.type as ContentType) ? r.type : "spotlight") as ContentType,
          hook: strip(r.hook),
          caption: strip(r.caption),
          hashtags: (Array.isArray(r.hashtags) ? r.hashtags : String(r.hashtags ?? "").split(/[\s,]+/))
            .map((h) => cleanTag(String(h))).filter(Boolean).slice(0, 6),
          format: (FORMATS.includes(r.format as ContentFormat) ? r.format : "photo") as ContentFormat,
          timing: strip(r.timing),
          cta: strip(r.cta),
        }))
        .filter((i) => i.offering && i.caption)
        .slice(0, 10);
      if (ideas.length) return { summary: summaryStr, ideas, offeringsSeen: offeringLines.length, at };
    } catch (e) {
      if (process.env.CONTENT_DEBUG) console.error("generateContentPlan error:", (e as Error).message);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
  }
  return empty(at, offeringLines.length, true);
}

export function contentPlanIsGood(p: ContentPlan): boolean {
  if (p.failed) return false; // a failed AI read is never "good" — retry it
  return !!(p.ideas.length || p.empty);
}

/** Cached content plan — served instantly, regenerated in the background when stale. */
export function getOrMakeContentPlan(ws: WorkspaceRow, maxAgeHours = 24): Promise<ContentPlan> {
  return staleCached(ws, "contentPlan", maxAgeHours, () => generateContentPlan(ws), { isValid: (c) => !c.failed });
}
