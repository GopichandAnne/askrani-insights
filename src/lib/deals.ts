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

const SOCIAL = ["instagram", "facebook", "tiktok"];

export interface DealItem { rival: string; deal: string; item?: string; when?: string; url?: string }
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

export async function generateDeals(ws: WorkspaceRow, db?: RlsClient): Promise<DealsReport> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.competitorIds.length) return empty(at);

  const { data: posts } = await supabase
    .from("content_item")
    .select("text, url, published_at, observed_at, business:business_id(canonical_name)")
    .in("business_id", ids.competitorIds)
    .in("platform", SOCIAL)
    .order("observed_at", { ascending: false })
    .limit(300);

  const ranked = (posts ?? [])
    .map((p) => ({
      rival: (p as any).business?.canonical_name ?? "A rival",
      caption: String((p as any).text ?? "").replace(/\s+/g, " ").trim(),
      url: (p as any).url ?? undefined,
    }))
    .filter((p) => p.caption.length > 8)
    .slice(0, 90);
  if (ranked.length < 3) return empty(at);
  if (!isLlmConfigured()) return { summary: "", deals: [], moves: [], postsSeen: ranked.length, at, empty: true };

  const list = ranked.map((p, i) => `[${i}] ${p.rival}: ${p.caption.slice(0, 220)}`).join("\n");
  const prompt = `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\nRIVAL SOCIAL POSTS:\n${list}\n\nExtract the deals/promos they're running (fill the deals array).`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ deals: unknown; summary: string; moves: unknown }>({
        system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 1800,
      });
      const deals: DealItem[] = parseArrays(data.deals)
        .map((d) => {
          const src = ranked[Number(d.index)];
          const deal = strip(d.deal);
          if (!src || !deal) return null;
          return { rival: src.rival, deal, item: strip(d.item) || undefined, when: strip(d.when) || undefined, url: src.url } as DealItem;
        })
        .filter((d): d is DealItem => !!d)
        .slice(0, 12);
      if (deals.length) {
        return { summary: strip(data.summary), deals, moves: parseArrays(data.moves).map((m) => strip(String(m))).filter(Boolean).slice(0, 4), postsSeen: ranked.length, at };
      }
    } catch { /* retry */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
  }
  return empty(at, true);
}

export function dealsIsGood(d: DealsReport): boolean {
  return !!(d.deals.length || d.empty);
}

/** Cached deals report (regenerated when older than maxAgeHours). */
export async function getOrMakeDeals(ws: WorkspaceRow, maxAgeHours = 12): Promise<DealsReport> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as { deals?: DealsReport } | null)?.deals;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && !cached.failed) return cached;

  const fresh = await generateDeals(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), deals: fresh } }).eq("id", ws.id);
  return fresh;
}
