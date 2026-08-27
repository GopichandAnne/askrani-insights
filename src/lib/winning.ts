import { staleCached } from "@/lib/staleCache";
import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { dedupeCrossPost } from "@/lib/dedupe";

/**
 * "What's winning" — the entity-level fusion, the moat. Instead of business-level
 * or theme-level, it rolls signals up to the OFFERING itself (a dish / treatment
 * / product) across the whole local market, fusing four sources we already have:
 *   • MENU (offer rows) — who offers it + at what price (prevalence + price band)
 *   • REVIEWS — what customers say about it
 *   • SOCIAL — which offerings rivals post about + engagement
 * → the specific things winning locally right now, whether YOU offer them, and
 * the move (add it / promote it / reprice). Cached on workspace.goals.winning.
 */

const SOCIAL = ["instagram", "facebook", "tiktok", "youtube"];
const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;
// size / qualifier / unit noise stripped only for dedup counting (display keeps original)
const NOISE = /\b(small|large|medium|regular|reg|half|full|single|double|pcs?|pc|oz|lb|ml|g|serves?\s*\d+|for\s*\d+)\b/gi;

export interface WinningEntity {
  name: string;
  offeredBy: number;            // # market businesses offering it
  priceRange: string;           // e.g. "$12–$18"
  onYourMenu: boolean;
  momentum: "hot" | "rising" | "steady";
  signal: string;               // fused evidence (menu + reviews + social)
  move: string;                 // concrete owner action
}
export interface WinningReport {
  summary: string;
  winning: WinningEntity[];
  entitiesSeen: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
const norm = (s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(NOISE, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "ONE short sentence intro. Keep it brief — the detail belongs in the `winning` array, not here." },
    winning: {
      type: "array", maxItems: 12,
      description: "REQUIRED — the main output. List 6–12 specific offerings winning in this local market, most compelling first. Include BOTH items the owner is missing (onYourMenu:false) AND winning items already on their menu (onYourMenu:true) — never leave this empty. Cluster the menu strings into real dishes/services. Ground EVERY row in the provided data — never invent an item, a count, or a number.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          menuItem: { type: "string", description: "the EXACT item label from the MARKET MENU list this offering is based on (copy it verbatim), or '' if it's purely review/social driven." },
          name: { type: "string", description: "the offering, cleanly named (e.g. 'Hyderabadi Chicken Biryani', 'Lip filler', 'Cold brew')" },
          momentum: { type: "string", enum: ["hot", "rising", "steady"], description: "hot = strong review/social traction now; rising = building; steady = consistently offered/liked" },
          signal: { type: "string", description: "the fused evidence in ONE short line (≤22 words) — menu prevalence + reviews + social. Real specifics, no invented numbers." },
          move: { type: "string", description: "one concrete move for THIS owner in ≤16 words (add it, promote it, reprice, feature in a reel…)" },
        },
        required: ["menuItem", "name", "momentum", "signal", "move"],
      },
    },
  },
  required: ["summary", "winning"],
};

const SYSTEM =
  "You are Ask Rani, finding what's WINNING in a local business category at the level of the specific offering — read it through the business's vertical (a dish for a restaurant, a product for a grocery, a treatment for a salon, a service/procedure for a dental practice such as implants, Invisalign, whitening, sedation, same-day crowns, or a new-patient special). Work ONLY from the provided market menu, customer reviews, and rival social posts. Cluster the raw menu strings into real offerings; judge what's winning by combining prevalence + review love + social traction. Your MAIN OUTPUT is the `winning` array — you MUST fill it with 6–10 offerings (a mix of ones the owner already has and gaps they're missing). Keep the summary to ONE short sentence; put the substance in the array. For each offering, copy the exact matching label from the MARKET MENU into `menuItem`, give the fused evidence, and one concrete move. Never invent an item or a number. Plain English.";

const empty = (at: string, failed = false): WinningReport => ({ summary: "", winning: [], entitiesSeen: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

// This big structured call sometimes makes the model render the `winning` array
// as an XML STRING (`<item><menuItem>…</menuItem><name>…</name>…`) or bleed
// `<parameter name="x">` tags instead of emitting JSON objects. The content is
// all there — recover it by parsing those tags. Tolerant of a truncated last item.
type RawItem = { menuItem?: string; name?: string; momentum?: string; signal?: string; move?: string };
function parseTaggedItems(s: string): RawItem[] {
  const normalized = s.replace(/<parameter\s+name="([^"]+)">/gi, (_m, t) => `<${t}>`);
  const chunks = normalized.includes("<item>") ? normalized.split(/<item>/i) : normalized.split(/(?=<menuItem>)/i);
  const get = (block: string, tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|<[a-z/]|$)`, "i").exec(block);
    return m ? m[1].trim() : "";
  };
  const out: RawItem[] = [];
  for (const block of chunks) {
    const name = get(block, "name") || get(block, "menuItem");
    const signal = get(block, "signal");
    if (!name || !signal) continue;
    out.push({ menuItem: get(block, "menuItem"), name, momentum: get(block, "momentum"), signal, move: get(block, "move") });
  }
  return out;
}

export async function generateWinning(ws: WorkspaceRow, db?: RlsClient): Promise<WinningReport> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all;
  if (!scope.length) return empty(at);

  const [{ data: bizRows }, { data: offers }, { data: reviews }, { data: postsRaw }] = await Promise.all([
    supabase.from("business").select("id, canonical_name").in("id", scope),
    supabase.from("offer").select("business_id, entity_text, pricing").in("business_id", scope).limit(6000),
    supabase.from("content_item").select("text").in("business_id", scope).in("platform", ["google", "yelp"]).order("observed_at", { ascending: false }).limit(600),
    supabase.from("content_item").select("text, platform, media, business:business_id(canonical_name)").in("business_id", ids.competitorIds).in("platform", SOCIAL).order("observed_at", { ascending: false }).limit(400),
  ]);
  // collapse the same post cross-posted to IG/FB/TikTok so it isn't counted twice
  const posts = dedupeCrossPost(postsRaw ?? []);

  const nameById = new Map<string, string>((bizRows ?? []).map((b) => [(b as any).id, (b as any).canonical_name]));
  const targetId = ids.targetId;

  // ── deterministic per-offering aggregation across the market ──
  interface Agg { display: string; businesses: Set<string>; prices: number[]; targetHas: boolean }
  const agg = new Map<string, Agg>();
  for (const o of offers ?? []) {
    const raw = String((o as any).entity_text ?? "").replace(/\s+/g, " ").trim();
    const key = norm(raw);
    if (key.length < 3) continue;
    const bid = (o as any).business_id as string;
    const a = agg.get(key) ?? { display: raw, businesses: new Set<string>(), prices: [], targetHas: false };
    a.businesses.add(nameById.get(bid) ?? bid);
    if (bid === targetId) a.targetHas = true;
    const amt = Number((o as any).pricing?.amount);
    if (Number.isFinite(amt) && amt > 0) a.prices.push(amt);
    if (raw.length < a.display.length) a.display = raw; // prefer the shortest label
    agg.set(key, a);
  }
  const priceBand = (p: number[]) => (p.length ? `$${Math.min(...p).toFixed(0)}–$${Math.max(...p).toFixed(0)}` : "");
  const candidates = [...agg.values()].map((a) => ({
    item: a.display, offeredBy: a.businesses.size, price: priceBand(a.prices), you: a.targetHas,
  }));
  // prevalence-first, but guarantee the target's own items are represented so onYourMenu is accurate
  const byPrevalence = candidates.filter((c) => !c.you).sort((a, b) => b.offeredBy - a.offeredBy).slice(0, 40);
  const yours = candidates.filter((c) => c.you).sort((a, b) => b.offeredBy - a.offeredBy).slice(0, 22);
  const menuLines = [...byPrevalence, ...yours];
  if (menuLines.length < 4) return empty(at);

  // lookup for deterministic attach of prevalence/price/on-your-menu by item label
  const candByNorm = new Map(candidates.map((c) => [norm(c.item), c]));
  const yourKeys = new Set(yours.map((c) => norm(c.item)));

  // review corpus (drop the "Rated X★" aggregate summaries)
  const reviewSnips = (reviews ?? [])
    .map((r) => String((r as any).text ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 20 && !RATING_RE.test(t))
    .slice(0, 18)
    .map((t) => t.slice(0, 180));

  // top social captions by engagement
  const socialSnips = (posts ?? [])
    .map((p) => ({ business: (p as any).business?.canonical_name ?? "A rival", caption: String((p as any).text ?? "").replace(/\s+/g, " ").trim(), eng: engOf(metricsOf((p as any).media)) }))
    .filter((p) => p.caption.length > 6)
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 12)
    .map((p) => `${p.business}${p.eng ? ` (${p.eng} eng)` : ""}: ${p.caption.slice(0, 140)}`);

  if (!isLlmConfigured()) return { summary: "", winning: [], entitiesSeen: menuLines.length, at, empty: true };

  const marketMenu = menuLines.map((c) => `${c.item} | ${c.offeredBy} biz | ${c.price || "no price"}${c.you ? " | YOURS" : ""}`).join("\n");
  const prompt =
    `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\n` +
    `MARKET MENU (item | # businesses | price band | YOURS if on ${ws.name}'s menu):\n${marketMenu}\n\n` +
    `CUSTOMER REVIEWS (market):\n${reviewSnips.join("\n") || "(none)"}\n\n` +
    `RIVAL SOCIAL POSTS BY ENGAGEMENT:\n${socialSnips.join("\n") || "(none)"}\n\n` +
    `List what's winning (fill the winning array).`;

  // The model occasionally renders the array as an XML string on this big call;
  // parseTaggedItems recovers it. Still retry a couple times as a backstop.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ summary: string; winning: RawItem[] | string }>({
        system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 2600,
      });
      const rows: RawItem[] = Array.isArray(data.winning)
        ? (data.winning as RawItem[])
        : typeof data.winning === "string"
          ? parseTaggedItems(data.winning)
          : [];
      const winning: WinningEntity[] = rows
        .map((w) => {
          const name = strip(w.name) || strip(w.menuItem);
          if (!name) return null;
          // attach prevalence / price / on-your-menu deterministically from our
          // data — trust only a real menu match (the loose token fallback
          // mis-bucketed rivals' items as the owner's).
          const cand = candByNorm.get(norm(String(w.menuItem ?? ""))) ?? candByNorm.get(norm(name));
          return {
            name,
            offeredBy: cand?.offeredBy ?? 0,
            priceRange: cand?.price ?? "",
            onYourMenu: !!cand?.you,
            momentum: (["hot", "rising", "steady"].includes(w.momentum ?? "") ? w.momentum : "steady") as WinningEntity["momentum"],
            signal: strip(w.signal),
            move: strip(w.move),
          } as WinningEntity;
        })
        .filter((w): w is WinningEntity => !!w && !!w.signal)
        .slice(0, 12);
      if (winning.length) return { summary: strip(data.summary), winning, entitiesSeen: agg.size, at };
      // empty/malformed (occasional tool-XML bleed on this big call) → retry
    } catch (e) {
      if (process.env.WINNING_DEBUG) console.error("generateWinning LLM error:", (e as Error).message);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000)); // back off (transient overload / rate limit)
  }
  return empty(at, true);
}

/** Non-empty when we produced winning offerings (warm-retry predicate). */
export function winningIsGood(w: WinningReport): boolean {
  if (w.failed) return false; // a failed AI read is never "good" — retry it
  return !!(w.winning.length || w.empty);
}

/** Cached winning report (regenerated when older than maxAgeHours). */
export function getOrMakeWinning(ws: WorkspaceRow, maxAgeHours = 12): Promise<WinningReport> {
  return staleCached(ws, "winning", maxAgeHours, () => generateWinning(ws), { isValid: (c) => !c.failed });
}
