import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * The "menu edge" lens — deterministic (no LLM), from the offer prices we already
 * collect. Two owner questions the other surfaces don't answer at the item level:
 *   • Am I priced right? → per-item price vs the market for the SAME item.
 *   • What makes me unique? → items I offer that no nearby rival does.
 * Cached on workspace.goals.menu.
 */

const NOISE = /\b(small|large|medium|regular|reg|half|full|single|double|pcs?|pc|oz|lb|ml|serves?\s*\d+|for\s*\d+)\b/gi;
const norm = (s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(NOISE, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();

// Words too generic to signal uniqueness — the DISTINCTIVE part of a dish name is
// what's left after removing common proteins/bases/format words.
const GENERIC = new Set([
  "chicken", "mutton", "goat", "lamb", "beef", "fish", "prawn", "shrimp", "egg", "paneer", "veg", "vegetable", "vegetarian",
  "rice", "curry", "masala", "gravy", "fried", "grill", "grilled", "roast", "roasted", "tandoori", "spicy", "hot", "fresh",
  "meal", "combo", "plate", "bowl", "cup", "special", "house", "style", "served", "with", "and", "plus", "the", "our",
  "side", "extra", "classic", "signature", "deluxe", "family", "mini", "jumbo", "large", "regular",
]);
const distinctiveTokens = (key: string) => key.split(" ").filter((t) => t.length >= 4 && !GENERIC.has(t));

export interface PricePosition {
  item: string;
  yourPrice: number;
  marketAvg: number;
  marketMin: number;
  marketMax: number;
  deltaPct: number;                       // your price vs market avg
  position: "over" | "under" | "inline";
  rivalCount: number;                     // rivals offering the same item (priced)
}
export interface Differentiator { item: string; yourPrice: number; }
export interface MenuLens {
  pricePositions: PricePosition[];
  differentiators: Differentiator[];
  itemsCompared: number;                  // # of your priced items we could match
  at: string;
  empty?: boolean;
}

const empty = (at: string): MenuLens => ({ pricePositions: [], differentiators: [], itemsCompared: 0, at, empty: true });

export async function buildMenuLens(ws: WorkspaceRow, db?: RlsClient): Promise<MenuLens> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.targetId || !ids.competitorIds.length) return empty(at);

  const { data: offers } = await supabase
    .from("offer")
    .select("business_id, entity_text, pricing")
    .in("business_id", ids.all)
    .limit(8000);

  // per business: normItem → { display (shortest label), price (min positive) }
  const byBiz = new Map<string, Map<string, { display: string; price: number | null }>>();
  for (const o of offers ?? []) {
    const bid = (o as any).business_id as string;
    const raw = String((o as any).entity_text ?? "").replace(/\s+/g, " ").trim();
    const key = norm(raw);
    if (key.length < 3) continue;
    const amt = Number((o as any).pricing?.amount);
    const price = Number.isFinite(amt) && amt > 0 ? amt : null;
    const m = byBiz.get(bid) ?? new Map<string, { display: string; price: number | null }>();
    const cur = m.get(key);
    if (!cur) m.set(key, { display: raw, price });
    else {
      if (price != null && (cur.price == null || price < cur.price)) cur.price = price;
      if (raw.length < cur.display.length) cur.display = raw;
    }
    byBiz.set(bid, m);
  }

  const targetMap = byBiz.get(ids.targetId);
  if (!targetMap || !targetMap.size) return empty(at);
  const rivalMaps = ids.competitorIds.map((id) => byBiz.get(id)).filter(Boolean) as Map<string, { display: string; price: number | null }>[];

  // rival aggregation: exact-item prices (for pricing) + a distinctive-token index (for uniqueness)
  const rivalByItem = new Map<string, number[]>();
  const rivalTokens = new Set<string>();
  for (const m of rivalMaps)
    for (const [key, v] of m) {
      if (v.price != null) (rivalByItem.get(key) ?? rivalByItem.set(key, []).get(key)!).push(v.price);
      for (const t of distinctiveTokens(key)) rivalTokens.add(t);
    }

  // ── per-item price positioning (same item you AND rivals price) ──
  const pricePositions: PricePosition[] = [];
  for (const [key, v] of targetMap) {
    if (v.price == null) continue;
    const prices = rivalByItem.get(key);
    if (!prices || !prices.length) continue;
    const marketAvg = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (marketAvg <= 0) continue;
    const deltaPct = Math.round(((v.price - marketAvg) / marketAvg) * 100);
    pricePositions.push({
      item: v.display,
      yourPrice: v.price,
      marketAvg: Number(marketAvg.toFixed(2)),
      marketMin: Math.min(...prices),
      marketMax: Math.max(...prices),
      deltaPct,
      position: deltaPct > 5 ? "over" : deltaPct < -5 ? "under" : "inline",
      rivalCount: prices.length,
    });
  }
  pricePositions.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

  // ── your differentiators (priced items no rival's items share a distinctive token with) ──
  const differentiators: Differentiator[] = [];
  for (const [key, v] of targetMap) {
    if (v.price == null) continue;
    if (rivalByItem.has(key)) continue; // an exact match exists → not unique
    const toks = distinctiveTokens(key);
    if (!toks.length) continue; // too generic to claim as unique
    if (toks.some((t) => rivalTokens.has(t))) continue; // a rival shares the distinctive part
    differentiators.push({ item: v.display, yourPrice: v.price });
  }
  differentiators.sort((a, b) => b.yourPrice - a.yourPrice);

  return { pricePositions: pricePositions.slice(0, 10), differentiators: differentiators.slice(0, 10), itemsCompared: targetMap.size, at };
}

/** Cached menu lens (deterministic; regenerated when older than maxAgeHours). */
export async function getOrMakeMenuLens(ws: WorkspaceRow, maxAgeHours = 12): Promise<MenuLens> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as { menu?: MenuLens } | null)?.menu;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000) return cached;

  const fresh = await buildMenuLens(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), menu: fresh } }).eq("id", ws.id);
  return fresh;
}
