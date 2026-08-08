import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * The "menu edge" lens — answers two owner questions at the item level:
 *   • Am I priced right? → your price vs the market for the SAME dish.
 *   • What makes me unique? → dishes I offer that no nearby rival does.
 *
 * The MATCHING is intelligent (LLM): it treats "Chicken Dum Biryani",
 * "Hyderabadi Chicken Biryani" and "Chicken Biryani" as the same dish — the way a
 * human reading the menus would — rather than exact-string matching. The MATH
 * (deltas, avgs) is computed deterministically from the real offer prices the
 * model was given, so nothing is invented. Falls back to a conservative exact-
 * match pass if the LLM is unavailable. Cached on workspace.goals.menu.
 */

const NOISE = /\b(small|large|medium|regular|reg|half|full|single|double|pcs?|pc|oz|lb|ml|serves?\s*\d+|for\s*\d+)\b/gi;
const norm = (s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(NOISE, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();

// generic words that don't signal a distinctive dish (used only to VALIDATE the
// LLM's "differentiators" against the FULL rival menu, catching false uniqueness).
const GENERIC = new Set([
  // food
  "chicken", "mutton", "goat", "lamb", "beef", "fish", "prawn", "shrimp", "egg", "paneer", "veg", "vegetable", "vegetarian",
  "rice", "curry", "masala", "gravy", "fried", "grill", "grilled", "roast", "tandoori", "spicy", "plain", "combo", "meal",
  "plate", "bowl", "lunch", "dinner", "box",
  // beauty / med-spa modifiers
  "treatment", "session", "sessions", "area", "areas", "unit", "units", "syringe", "syringes", "package", "add",
  // grocery / units
  "gallon", "gal", "pack", "count", "dozen", "bottle", "can", "jar", "bag",
  // universal
  "special", "house", "style", "with", "and", "plus", "the", "our", "side", "extra", "family", "regular", "small", "large", "mini", "classic", "signature", "deluxe",
]);
const distinctive = (name: string) => norm(name).split(" ").filter((t) => t.length >= 4 && !GENERIC.has(t));

export interface PricePosition {
  item: string;
  yourPrice: number;
  marketAvg: number;
  marketMin: number;
  marketMax: number;
  deltaPct: number;
  position: "over" | "under" | "inline";
  rivalCount: number;
}
export interface Differentiator { item: string; yourPrice: number }
export interface MenuLens {
  pricePositions: PricePosition[];
  differentiators: Differentiator[];
  itemsCompared: number;
  at: string;
  empty?: boolean;
}

const empty = (at: string): MenuLens => ({ pricePositions: [], differentiators: [], itemsCompared: 0, at, empty: true });

// Build {display, price} per business, deduped by normalized name (min positive price).
async function gatherMenus(ws: WorkspaceRow, db: RlsClient) {
  const ids = await workspaceBusinessIds(ws, db);
  if (!ids.targetId || !ids.competitorIds.length) return null;
  const { data: offers } = await db.from("offer").select("business_id, entity_text, pricing").in("business_id", ids.all).limit(8000);
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
  if (!targetMap?.size) return null;
  const yours = [...targetMap.values()].filter((v) => v.price != null) as { display: string; price: number }[];
  const rivals: { item: string; price: number }[] = [];
  const rivalNames: string[] = []; // ALL rival items (priced or not) — for the uniqueness safety net
  for (const id of ids.competitorIds) for (const v of byBiz.get(id)?.values() ?? []) {
    rivalNames.push(v.display);
    if (v.price != null) rivals.push({ item: v.display, price: v.price });
  }
  return { yours, rivals, rivalNames, itemsCompared: targetMap.size };
}

const round = (n: number) => Number(n.toFixed(2));
function positionFrom(item: string, yourPrice: number, marketPrices: number[]): PricePosition | null {
  const prices = marketPrices.filter((p) => Number.isFinite(p) && p > 0);
  if (!prices.length || !(yourPrice > 0)) return null;
  const marketAvg = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (marketAvg <= 0) return null;
  const deltaPct = Math.round(((yourPrice - marketAvg) / marketAvg) * 100);
  return {
    item, yourPrice: round(yourPrice), marketAvg: round(marketAvg), marketMin: round(Math.min(...prices)), marketMax: round(Math.max(...prices)),
    deltaPct, position: deltaPct > 5 ? "over" : deltaPct < -5 ? "under" : "inline", rivalCount: prices.length,
  };
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    pricePositions: {
      type: "array", maxItems: 14,
      description: "Your items that at least one rival ALSO sells (same dish, matched by meaning not spelling). Biggest price gaps first.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          item: { type: "string", description: "the dish, cleanly named" },
          yourPrice: { type: "number", description: "the owner's price for it (from YOUR MENU)" },
          marketPrices: { type: "array", items: { type: "number" }, description: "the rivals' prices for the SAME dish (from RIVAL MENUS) — real numbers only, one per rival that has it" },
        },
        required: ["item", "yourPrice", "marketPrices"],
      },
    },
    differentiators: {
      type: "array", maxItems: 12,
      description: "Your items that NO rival offers an equivalent of (unique to you). Skip generic staples every place has.",
      items: {
        type: "object", additionalProperties: false,
        properties: { item: { type: "string" }, yourPrice: { type: "number" } },
        required: ["item", "yourPrice"],
      },
    },
  },
  required: ["pricePositions", "differentiators"],
};

const SYSTEM =
  "You compare a local business's OFFERINGS to its rivals' the way a knowledgeable human would — for ANY vertical (restaurant dishes, salon/med-spa treatments, grocery products). Match offerings by MEANING, not spelling — the same thing regardless of name variants: e.g. 'Chicken Dum Biryani' = 'Hyderabadi Chicken Biryani' = 'Chicken Biryani' (restaurant); 'Lip Filler 1 Syringe' = 'Lip Filler' = 'Lip Injections' (med spa); '2% Milk 1 Gallon' = 'Milk' (grocery). Keep genuinely different things separate ('Paneer 65' ≠ 'Chilli Paneer'; 'Botox' ≠ 'Lip Filler'; 'Whole Milk' ≠ '2% Milk'). For each of the owner's priced offerings a rival also sells, return the owner's price and the rivals' prices for that same offering (use ONLY prices present in the data — never invent). Offerings with no rival equivalent are differentiators (skip truly generic staples). Return the biggest price gaps first.";

function parseArrays(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

export async function buildMenuLens(ws: WorkspaceRow, db?: RlsClient): Promise<MenuLens> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const menus = await gatherMenus(ws, supabase);
  if (!menus) return empty(at);
  const { yours, rivals, rivalNames, itemsCompared } = menus;
  // safety nets computed over the FULL rival menu (not the capped prompt sample):
  const rivalPriceSet = new Set(rivals.map((r) => Math.round(r.price * 100))); // real prices, in cents
  const rivalTokenSet = new Set<string>();
  for (const n of rivalNames) for (const t of distinctive(n)) rivalTokenSet.add(t);
  const priceIsReal = (p: number) => rivalPriceSet.has(Math.round(p * 100));
  const trulyUnique = (item: string) => { const t = distinctive(item); return t.length > 0 && !t.some((x) => rivalTokenSet.has(x)); };

  // Intelligent path: LLM matches dishes semantically; we do the arithmetic.
  if (isLlmConfigured() && yours.length && rivals.length) {
    // dedup rival lines by name+price, cap for the prompt
    const seen = new Set<string>();
    const rivalLines = rivals.filter((r) => { const k = `${norm(r.item)}|${r.price}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 140).map((r) => `${r.item} — $${r.price}`).join("\n");
    const yourLines = yours.slice(0, 70).map((y) => `${y.display} — $${y.price}`).join("\n");
    const yourByNorm = new Map(yours.map((y) => [norm(y.display), y.price]));

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data } = await getLlm().callStructured<{ pricePositions: any; differentiators: any }>({
          system: SYSTEM,
          text: `YOUR OFFERINGS (${ws.name} — ${ws.vertical}):\n${yourLines}\n\nRIVAL OFFERINGS:\n${rivalLines}\n\nMatch offerings by meaning and compare.`,
          schema: SCHEMA, tier: "extract", maxTokens: 1800,
        });
        const pp = parseArrays(data.pricePositions)
          .map((p) => {
            // trust the model's semantic match, but anchor yourPrice to the real
            // menu and keep only rival prices that actually exist in the data.
            const yp = yourByNorm.get(norm(String(p.item ?? ""))) ?? Number(p.yourPrice);
            const mkt = (Array.isArray(p.marketPrices) ? p.marketPrices.map(Number) : []).filter(priceIsReal);
            return positionFrom(String(p.item ?? "").trim(), Number(yp), mkt);
          })
          .filter((x): x is PricePosition => !!x && !!x.item)
          .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
          .slice(0, 10);
        const diffs: Differentiator[] = parseArrays(data.differentiators)
          .map((d) => ({ item: String(d.item ?? "").trim(), yourPrice: round(Number(d.yourPrice)) }))
          .filter((d) => d.item && d.yourPrice > 0 && trulyUnique(d.item)) // drop false "unique" a rival actually has
          .sort((a, b) => b.yourPrice - a.yourPrice)
          .slice(0, 10);
        if (pp.length || diffs.length) return { pricePositions: pp, differentiators: diffs, itemsCompared, at };
      } catch { /* retry */ }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // Fallback: conservative exact-normalized-name match (no LLM).
  return deterministicMenuLens(ws, supabase, at);
}

async function deterministicMenuLens(ws: WorkspaceRow, db: RlsClient, at: string): Promise<MenuLens> {
  const menus = await gatherMenus(ws, db);
  if (!menus) return empty(at);
  const rivalByItem = new Map<string, number[]>();
  for (const r of menus.rivals) { const k = norm(r.item); (rivalByItem.get(k) ?? rivalByItem.set(k, []).get(k)!).push(r.price); }
  const yourByItem = new Map<string, { display: string; price: number }>();
  for (const y of menus.yours) { const k = norm(y.display); if (!yourByItem.has(k)) yourByItem.set(k, y); }
  const pricePositions: PricePosition[] = [];
  const differentiators: Differentiator[] = [];
  for (const [k, y] of yourByItem) {
    const prices = rivalByItem.get(k);
    if (prices?.length) { const p = positionFrom(y.display, y.price, prices); if (p) pricePositions.push(p); }
    else if (k.split(" ").some((t) => t.length >= 5)) differentiators.push({ item: y.display, yourPrice: round(y.price) });
  }
  pricePositions.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  differentiators.sort((a, b) => b.yourPrice - a.yourPrice);
  return { pricePositions: pricePositions.slice(0, 10), differentiators: differentiators.slice(0, 10), itemsCompared: menus.itemsCompared, at };
}

/** Cached menu lens (regenerated when older than maxAgeHours). */
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
