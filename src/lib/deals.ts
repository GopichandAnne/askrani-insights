import { staleCached } from "@/lib/staleCache";
import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Deals rivals are posting" — the offer/pricing lens that fits GROCERY (and helps
 * restaurants' specials + med-spas' promos): local businesses broadcast their
 * sales/promos on social (weekend sale flyers, "on special", price drops). This
 * reads competitor social captions and extracts the REAL deals — what's on offer,
 * the price/terms if stated, and when — so the owner can match or counter.
 * Cached on workspace.goals.deals.
 *
 * NOTE: many grocery deals live inside flyer IMAGES, whose CDN URLs are blocked
 * (403) and aren't downloaded during collection — so this v1 reads what's in the
 * CAPTIONS. Reading image flyers needs a collection change (download + vision).
 */

// Where local businesses broadcast offers — social + Google posts + their own site.
// Grocery/restaurant weekly specials often live on Google & the website, not only IG.
const PROMO_SOURCES = ["instagram", "facebook", "tiktok", "youtube", "google", "website", "doordash", "ubereats"];

export interface DealItem { rival: string; deal: string; item?: string; when?: string; url?: string; source?: string; postedAt?: string }
export interface DealsReport {
  summary: string;
  deals: DealItem[];
  moves: string[];
  postsSeen: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const strip = (s?: string) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const empty = (at: string, failed = false): DealsReport => ({ summary: "", deals: [], moves: [], postsSeen: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    deals: {
      type: "array", maxItems: 14,
      description: "REQUIRED main output. The REAL deals/promos rivals are posting — a sale, discount, price drop, limited-time offer, bundle, or a clearly-promoted featured/new item. Reference each by its [index]. SKIP generic content, brand/lifestyle posts, and catering pitches that aren't an actual offer.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          index: { type: "integer", description: "the [index] of the post" },
          deal: { type: "string", description: "the offer in plain words (e.g. 'Fresh mangoes on special', '20% off catering trays', 'Buy 2 get 1 spice packs')" },
          item: { type: "string", description: "the product/item if identifiable, else ''" },
          when: { type: "string", description: "validity/timing if stated (e.g. 'this weekend', 'thru Sunday'), else ''" },
        },
        required: ["index", "deal"],
      },
    },
    summary: { type: "string", description: "ONE short sentence: what rivals are promoting right now." },
    moves: { type: "array", maxItems: 4, items: { type: "string" }, description: "Concrete moves for THIS owner (match a price, counter-promote a category, run your own on X)." },
  },
  required: ["deals", "summary", "moves"],
};

const SYSTEM =
  "You extract the DEALS a local business's rivals are posting on social — sales, discounts, price drops, limited-time offers, bundles, or clearly-promoted featured/new items — the way an owner scanning competitors' feeds would. Work ONLY from the captions given; never invent a price or offer. Your MAIN OUTPUT is the `deals` array (reference each post by its [index]); skip generic/lifestyle/brand posts and catering pitches that aren't an actual offer. Keep the summary to one sentence. Plain English.";

function parseArrays(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : Array.isArray(p?.deals) ? p.deals : []; } catch { return []; } }
  return [];
}

/** Core deal extraction over a given set of businesses. `own=true` reframes it as
 *  the owner's OWN current offers (their posts) rather than rivals'. */
async function runDeals(ws: WorkspaceRow, businessIds: string[], db: RlsClient, own = false): Promise<DealsReport> {
  const at = new Date().toISOString();
  if (!businessIds.length) return empty(at);

  const { data: posts } = await db
    .from("content_item")
    .select("text, url, platform, observed_at, published_at, business:business_id(canonical_name)")
    .in("business_id", businessIds)
    .in("platform", PROMO_SOURCES)
    .order("observed_at", { ascending: false })
    .limit(400);

  const ranked = (posts ?? [])
    .map((p) => ({
      rival: (p as any).business?.canonical_name ?? (own ? ws.name : "A rival"),
      caption: String((p as any).text ?? "").replace(/\s+/g, " ").trim(),
      url: (p as any).url ?? undefined,
      source: (p as any).platform as string | undefined,
      postedAt: ((p as any).published_at ?? (p as any).observed_at) as string | undefined,
    }))
    .filter((p) => p.caption.length > 8)
    .slice(0, 90);
  if (ranked.length < 3) return empty(at);
  if (!isLlmConfigured()) return { summary: "", deals: [], moves: [], postsSeen: ranked.length, at, empty: true };

  const list = ranked.map((p, i) => `[${i}] ${p.rival} (${p.source ?? "web"}): ${p.caption.slice(0, 220)}`).join("\n");
  const prompt = own
    ? `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\nTHIS BUSINESS'S OWN POSTS:\n${list}\n\nExtract the deals/promos THIS business is currently running (fill the deals array). Leave moves empty.`
    : `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\nRIVAL POSTS (social, Google, website, delivery apps):\n${list}\n\nExtract the deals/promos the rivals are running — including DoorDash/Uber Eats promotions like free/discounted delivery, % off, or BOGO (fill the deals array).`;
  const system = own ? SYSTEM.replace("a local business's rivals are posting", `the business "${ws.name}" is posting`) : SYSTEM;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ deals: unknown; summary: string; moves: unknown }>({
        system, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 2600,
      });
      const deals: DealItem[] = parseArrays(data.deals)
        .map((d) => {
          const src = ranked[Number(d.index)];
          const deal = strip(d.deal);
          if (!src || !deal) return null;
          return { rival: src.rival, deal, item: strip(d.item) || undefined, when: strip(d.when) || undefined, url: src.url, source: src.source, postedAt: src.postedAt } as DealItem;
        })
        .filter((d): d is DealItem => !!d)
        .slice(0, 14);
      if (deals.length) {
        return { summary: strip(data.summary), deals, moves: own ? [] : parseArrays(data.moves).map((m) => strip(String(m))).filter(Boolean).slice(0, 4), postsSeen: ranked.length, at };
      }
    } catch { /* retry */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
  }
  return empty(at, true);
}

export async function generateDeals(ws: WorkspaceRow, db?: RlsClient): Promise<DealsReport> {
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  return runDeals(ws, ids.competitorIds, supabase, false);
}

/** The owner's OWN current offers — for the yours-vs-theirs comparison. */
export async function generateMyDeals(ws: WorkspaceRow, db?: RlsClient): Promise<DealsReport> {
  const supabase = db ?? (await createClient());
  return runDeals(ws, ws.target_business_id ? [ws.target_business_id] : [], supabase, true);
}

export function dealsIsGood(d: DealsReport): boolean {
  if (d.failed) return false; // a failed AI read is never "good" — retry it
  return !!(d.deals.length || d.empty);
}

/** Cached deals report — served instantly, regenerated in the background when stale. */
export function getOrMakeDeals(ws: WorkspaceRow, maxAgeHours = 12): Promise<DealsReport> {
  return staleCached(ws, "deals", maxAgeHours, () => generateDeals(ws), { isValid: (c) => !c.failed });
}

/** Cached OWN-offers report (goals.myDeals) — served instantly, refreshed in bg. */
export function getOrMakeMyDeals(ws: WorkspaceRow, maxAgeHours = 12): Promise<DealsReport> {
  return staleCached(ws, "myDeals", maxAgeHours, () => generateMyDeals(ws), { isValid: (c) => !c.failed });
}
