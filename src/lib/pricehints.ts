import { staleCached } from "@/lib/staleCache";
import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Price HINTS — the "how do you get a hint into competitors' pricing?" answer.
 * Nobody sees a competitor's fee schedule; you piece prices together from what
 * gets said in public. We do the same, mining the free text we've ALREADY collected
 * (reviews on Google/Yelp/Healthgrades/Zocdoc AND the businesses' own Instagram/
 * Facebook/TikTok posts) across the target AND every competitor for real prices —
 * either a customer reporting what they PAID ("$1,500 for the crown", "great value
 * $120 cleaning") or a business ADVERTISING one ("$89 new-patient special", "$18
 * biryani").
 *
 * Vertical-agnostic: the model maps each amount to a short canonical offering label
 * (crown / implant / cleaning / biryani …) so we can aggregate a market view per
 * offering. Zero new data source, zero new scraping cost — pure extraction on data
 * already in content_item. Each hint keeps its source + date + quote so it's an
 * honest, citable signal (a range, never a fabricated exact fee). Cached on
 * goals.priceHints. Most valuable for verticals with no published price list
 * (dental, services), where reviews + promo posts are the only price signal.
 */

const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;
// a review that plausibly names a dollar amount (not just a "$$" price tier)
const PRICE_RE = /\$\s?\d|\b\d{2,4}\s?(?:dollars|bucks)\b/i;
const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export interface PriceHint { business: string; isYou: boolean; item: string; amount: number; sentiment: "value" | "steep" | "neutral"; source: string; when?: string; quote: string }
export interface PriceHintItem { item: string; mentions: number; median: number; low: number; high: number; businesses: number }
export interface PriceHintsReport { at: string; hints: PriceHint[]; byItem: PriceHintItem[]; summary: string; reviewsScanned: number; empty?: boolean; failed?: boolean }

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prices: {
      type: "array",
      description: "Every real price a customer states in these reviews. Skip if a review names no concrete dollar amount for a specific offering.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          review_index: { type: "integer", description: "the [n] index of the review this came from" },
          item: { type: "string", description: "a SHORT canonical label for what the price was for, lowercase singular — e.g. 'crown', 'implant', 'cleaning', 'root canal', 'invisalign', 'biryani', 'haircut'. Normalize synonyms ('teeth cleaning'→'cleaning')." },
          amount: { type: "number", description: "the dollar amount the customer names (USD). If a range, use the midpoint." },
          sentiment: { type: "string", enum: ["value", "steep", "neutral"], description: "how the customer framed the price: value = a good deal, steep = expensive/overpriced, neutral = just stated." },
        },
        required: ["review_index", "item", "amount", "sentiment"],
      },
    },
  },
  required: ["prices"],
};

const SYSTEM =
  "You extract real PRICES from local-business reviews and posts. For each snippet that names a concrete dollar amount — a customer reporting what they PAID/were quoted, OR the business ADVERTISING a price/special — output the amount + a short canonical label for the offering + how the price is framed. Read it through the business's vertical (a dish for a restaurant, a product for a grocery, a service/procedure for a dental practice — crown, implant, cleaning, Invisalign, whitening). Rules: ONLY prices tied to a specific offering — ignore tips, taxes, a bare total with no item, generic '$$'/'affordable'/'expensive' with no number, and discount percentages with no dollar figure. Never invent or estimate a number that isn't stated. Normalize the item label to a short lowercase singular noun so the same offering groups together. sentiment: value = framed as a good deal/special, steep = expensive/overpriced, neutral = just stated or advertised.";

const empty = (at: string, failed = false): PriceHintsReport => ({ at, hints: [], byItem: [], summary: "", reviewsScanned: 0, empty: true, ...(failed ? { failed: true } : {}) });

export async function minePriceHints(ws: WorkspaceRow, db?: RlsClient): Promise<PriceHintsReport> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all.length ? ids.all : [];
  if (!scope.length) return empty(at);

  // reviews we've already collected, across the target AND competitors
  const { data: rows } = await supabase
    .from("content_item")
    .select("text, platform, published_at, observed_at, business:business_id(canonical_name), business_id")
    .in("business_id", scope)
    .in("platform", ["google", "yelp", "healthgrades", "zocdoc", "instagram", "facebook", "tiktok"])
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(800);

  const SOURCE_LABEL: Record<string, string> = { google: "Google review", yelp: "Yelp review", healthgrades: "Healthgrades review", zocdoc: "Zocdoc review", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok" };
  // keep only text that plausibly quotes a dollar amount (skip rating summaries)
  const candidates = (rows ?? [])
    .map((r: any) => ({
      business: (r.business as any)?.canonical_name ?? "Unknown",
      isYou: r.business_id === ids.targetId,
      source: SOURCE_LABEL[r.platform as string] ?? String(r.platform ?? ""),
      when: (r.published_at ?? r.observed_at) as string | undefined,
      text: clean(r.text),
    }))
    .filter((r) => r.text.length > 15 && !RATING_RE.test(r.text) && PRICE_RE.test(r.text))
    .slice(0, 120);

  if (!candidates.length) return empty(at);
  if (!isLlmConfigured()) return empty(at);

  const text =
    `Business type: ${ws.vertical}. Extract every real price customers state in these reviews.\n\n` +
    candidates.map((c, i) => `[${i}] (${c.business}) ${c.text.slice(0, 300)}`).join("\n");

  try {
    const call = () => getLlm().callStructured<{ prices: any[] }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 2200 });
    const { data } = await call().catch(() => call());
    const hints: PriceHint[] = (Array.isArray(data.prices) ? data.prices : [])
      .map((p): PriceHint | null => {
        const src = candidates[Number(p.review_index)];
        const amount = Number(p.amount);
        if (!src || !Number.isFinite(amount) || amount <= 0 || amount > 100000) return null;
        const item = clean(p.item).toLowerCase().slice(0, 40);
        if (item.length < 2) return null;
        const sentiment = (["value", "steep", "neutral"].includes(p.sentiment) ? p.sentiment : "neutral") as PriceHint["sentiment"];
        return { business: src.business, isYou: src.isYou, item, amount, sentiment, source: src.source, when: src.when, quote: src.text.slice(0, 160) };
      })
      .filter((h): h is PriceHint => h != null)
      .slice(0, 120);

    if (!hints.length) return { ...empty(at), reviewsScanned: candidates.length, empty: true };

    // aggregate a market view per offering (only items with a real mention)
    const groups = new Map<string, { amounts: number[]; biz: Set<string> }>();
    for (const h of hints) { const g = groups.get(h.item) ?? { amounts: [], biz: new Set() }; g.amounts.push(h.amount); g.biz.add(h.business); groups.set(h.item, g); }
    const byItem: PriceHintItem[] = [...groups.entries()]
      .map(([item, g]) => ({ item, mentions: g.amounts.length, median: Math.round(median(g.amounts)), low: Math.min(...g.amounts), high: Math.max(...g.amounts), businesses: g.biz.size }))
      .sort((a, b) => b.mentions - a.mentions || b.businesses - a.businesses)
      .slice(0, 24);

    const top = byItem.slice(0, 4).map((b) => `${b.item} ${b.low === b.high ? `$${b.low}` : `$${b.low}–$${b.high}`}`).join(", ");
    const summary = top ? `Prices customers mention across your market: ${top}.` : "";

    return { at, hints, byItem, summary, reviewsScanned: candidates.length };
  } catch {
    return empty(at, true);
  }
}

export function priceHintsIsGood(p: PriceHintsReport): boolean {
  if (p.failed) return false;
  return !!(p.hints.length || p.empty);
}

export function getOrMakePriceHints(ws: WorkspaceRow, maxAgeHours = 24): Promise<PriceHintsReport> {
  return staleCached(ws, "priceHints", maxAgeHours, () => minePriceHints(ws), { isValid: (c) => !c.failed });
}
