import { staleCached } from "@/lib/staleCache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Menu / service price comparison — for verticals with a BOUNDED, comparable
 * offering set (restaurants, salons, med-spas, cafés…), where the same dish or
 * service can be matched across competitors. NOT for grocery (huge SKU count →
 * noise). An LLM matches comparable items across the offer catalog, then gives a
 * per-competitor positioning overview + a few head-to-head item comparisons.
 * Cached on workspace.goals.menuCompare.
 */

/** Applicable to any bounded menu/service vertical (restaurant, salon, med-spa,
 *  café, barber…). Excluded for grocery, where the SKU count makes item-matching noise. */
export function menuCompareApplies(vertical: string): boolean {
  return vertical !== "grocery";
}

export interface MenuMatch { item: string; entries: { business: string; price: number; isYou: boolean }[]; note?: string }
export interface CompOverview { name: string; positioning: "cheaper" | "pricier" | "similar"; note: string }
export interface MenuCompareReport { summary: string; overview: CompOverview[]; matches: MenuMatch[]; at: string; empty?: boolean; failed?: boolean }

const clean = (s?: string) => String(s ?? "").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const emptyReport = (at: string, failed = false): MenuCompareReport => ({ summary: "", overview: [], matches: [], at, empty: true, ...(failed ? { failed: true } : {}) });

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", description: "ONE sentence: how this business's prices sit vs its local rivals overall." },
    overview: {
      type: "array", maxItems: 12, description: "One entry per COMPETITOR (not the owner) with a clear read.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string", description: "the competitor's name exactly as given" },
          positioning: { type: "string", enum: ["cheaper", "pricier", "similar"], description: "vs the market/owner overall" },
          note: { type: "string", description: "one specific phrase — e.g. 'runs ~15% under on entrées', 'premium on cocktails'" },
        },
        required: ["name", "positioning", "note"],
      },
    },
    matches: {
      type: "array", maxItems: 10, description: "Head-to-head comparisons: the SAME dish/service priced at ≥2 businesses. Use EXACT prices from the lists; never invent.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          item: { type: "string", description: "the shared dish/service, plain name" },
          entries: {
            type: "array", description: "each business offering it + its price",
            items: { type: "object", additionalProperties: false, properties: { business: { type: "string" }, price: { type: "number" } }, required: ["business", "price"] },
          },
          note: { type: "string", description: "short takeaway, e.g. 'you're $2 over the cheapest'" },
        },
        required: ["item", "entries"],
      },
    },
  },
  required: ["summary", "overview", "matches"],
};

const SYSTEM =
  "You are a pricing analyst comparing MENU / SERVICE prices across local competitors in the same category. Match items ONLY when they're genuinely the same dish or service (account for naming variants and synonyms; a 'Margherita' ≈ 'Margherita Pizza', 'Gel Mani' ≈ 'Gel Manicure'). For each meaningful match, list every business's EXACT price from the lists (never invent one). Then give a per-competitor overview: are they cheaper / pricier / similar vs the market, and on what (a specific category or item). Focus on what matters to an owner; skip one-off items no one else sells. Plain English.";

function parseArr(v: unknown): any[] { return Array.isArray(v) ? v : []; }

export async function generateMenuCompare(ws: WorkspaceRow): Promise<MenuCompareReport> {
  const at = new Date().toISOString();
  if (!menuCompareApplies(ws.vertical)) return emptyReport(at);
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.all.length) return emptyReport(at);

  const { data: offers } = await supabase
    .from("offer").select("entity_text, pricing, business_id, business:business_id(canonical_name)")
    .in("business_id", ids.all).limit(4000);

  // priced items per business, deduped by normalized name (keep first seen)
  const byBiz = new Map<string, { name: string; isYou: boolean; items: Map<string, number> }>();
  for (const o of offers ?? []) {
    const amt = Number((o.pricing as any)?.amount);
    if (!(amt > 0)) continue;
    const key = o.business_id as string;
    const name = (o.business as any)?.canonical_name ?? "A rival";
    if (!byBiz.has(key)) byBiz.set(key, { name, isYou: key === ids.targetId, items: new Map() });
    const b = byBiz.get(key)!;
    const nk = norm(clean(o.entity_text as string));
    if (nk && !b.items.has(nk)) b.items.set(nk, Number(amt.toFixed(2)));
  }
  const businesses = [...byBiz.values()].filter((b) => b.items.size > 0);
  if (businesses.filter((b) => !b.isYou).length < 1 || businesses.length < 2) return emptyReport(at);
  if (!isLlmConfigured()) return emptyReport(at);

  // build a compact per-business list (cap items so the prompt stays bounded)
  const block = businesses.map((b) => {
    const prices = [...b.items.values()];
    const avg = prices.reduce((a, c) => a + c, 0) / prices.length;
    const list = [...b.items.entries()].slice(0, 45).map(([nm, p]) => `- ${nm} @ $${p}`).join("\n");
    return `=== ${b.name}${b.isYou ? " (YOU)" : ""} — ${prices.length} priced items, avg $${avg.toFixed(2)} ===\n${list}`;
  }).join("\n\n");
  const prompt = `Local ${ws.vertical} price comparison for "${ws.name}".\n\n${block}\n\nMatch comparable items across businesses, give the per-competitor overview and head-to-head matches.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ summary: string; overview: unknown; matches: unknown }>({ system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 2200 });
      const nameSet = new Map(businesses.map((b) => [norm(b.name), b]));
      const overview: CompOverview[] = parseArr(data.overview)
        .map((o) => ({ name: clean(o.name), positioning: (["cheaper", "pricier", "similar"].includes(o.positioning) ? o.positioning : "similar") as CompOverview["positioning"], note: clean(o.note) }))
        .filter((o) => o.name && o.note && !nameSet.get(norm(o.name))?.isYou);
      const matches: MenuMatch[] = parseArr(data.matches).map((m) => {
        const entries = parseArr(m.entries).map((e) => ({ business: clean(e.business), price: Number(e.price), isYou: !!nameSet.get(norm(clean(e.business)))?.isYou })).filter((e) => e.business && Number.isFinite(e.price) && e.price > 0);
        return { item: clean(m.item), entries: entries.sort((a, b) => a.price - b.price), note: clean(m.note) || undefined };
      }).filter((m) => m.item && m.entries.length >= 2).slice(0, 10);
      if (overview.length || matches.length) return { summary: clean(data.summary), overview, matches, at };
    } catch { if (attempt === 0) await new Promise((r) => setTimeout(r, 3000)); }
  }
  return emptyReport(at, true);
}

export function getOrMakeMenuCompare(ws: WorkspaceRow, maxAgeHours = 24): Promise<MenuCompareReport> {
  if (!menuCompareApplies(ws.vertical)) return Promise.resolve(emptyReport(new Date().toISOString()));
  return staleCached(ws, "menuCompare", maxAgeHours, () => generateMenuCompare(ws), { isValid: (c) => !c.failed });
}
