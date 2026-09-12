import { createServiceClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { conceptKey } from "@/lib/conceptcanon";
import { vocabGet, vocabPut } from "@/lib/vocab";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Grocery concept-kind classifier (V2 "falling behind", grocery branch — G0).
 *
 * Grocery competition isn't restaurant-style "moves"; the market_event feed is
 * dominated by individual products (assortment) and facility gripes, so the
 * restaurant detector produced junk ("2 rivals sell flour, you don't") or nothing.
 * This tags each candidate concept so the grocery branch can keep only real
 * opportunities and drop the noise:
 *   • festival    — festival/pooja/seasonal basket item (an opening to merchandise)
 *   • trending    — a specific viral/emerging product gaining buzz (early-mover)
 *   • specialty   — a distinctive/regional/premium/organic line that differentiates
 *   • promotion   — a category-level deal/sale pattern
 *   • commodity   — a staple every grocery carries (rice, flour, oil, onions…) → DROP
 *   • facility    — a store-operations/quality gripe (cleanliness, restrooms…) → DROP
 *   • other       — DROP
 *
 * Cached FROZEN + additive (same discipline as the concept map): a concept's kind
 * is stable run-to-run; the LLM only classifies new ones. Reads the GLOBAL
 * per-vertical vocabulary first (concept_vocab, kind='grocery_kind') then this
 * workspace's own goals.groceryKinds as fallback, and writes new kinds to the
 * global table when available — so a NEW grocery store inherits the vertical's
 * established kinds instantly. Degrades to per-workspace when 0076 isn't applied.
 */

export type GroceryKind = "festival" | "trending" | "specialty" | "promotion" | "commodity" | "facility" | "other";
export const GROCERY_OPPORTUNITY: ReadonlySet<GroceryKind> = new Set<GroceryKind>(["festival", "trending", "specialty", "promotion"]);

interface GroceryKinds { assign: Record<string, GroceryKind>; at: string }

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    map: {
      type: "array", description: "One entry per input concept.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          i: { type: "integer" },
          kind: { type: "string", enum: ["festival", "trending", "specialty", "promotion", "commodity", "facility", "other"] },
        },
        required: ["i", "kind"],
      },
    },
  },
  required: ["map"],
};

const SYSTEM =
  "You classify GROCERY market concepts for a competitive opportunity detector. Each concept is a product, category, or theme observed across local grocers. Assign exactly one kind:\n" +
  "- festival: a festival / pooja / seasonal BASKET item or assortment (Diwali sweets, Ganesh idols, Ramadan dates, mango season) — an opening to merchandise on time.\n" +
  "- trending: a SPECIFIC viral / emerging product gaining buzz (e.g. a viral snack/chocolate), not a staple.\n" +
  "- specialty: a DISTINCTIVE / regional / premium / organic / imported line that differentiates a store — NOT something every grocery carries.\n" +
  "- promotion: a category-level DEAL / sale / weekend-special PATTERN.\n" +
  "- commodity: a STAPLE essentially every grocery already carries (rice, flour/atta, cooking oil, onions, milk, eggs, sugar, standard dals, common snacks, dry goods, produce) — the default for ordinary groceries.\n" +
  "- facility: a store OPERATIONS / quality gripe (cleanliness, pest control, restrooms, parking, crowding, checkout speed, trash cans, expiration/freshness).\n" +
  "- other: anything that fits none.\n" +
  "Be STRICT: default ordinary staples to commodity and operational complaints to facility. Only call something specialty/trending when it is genuinely distinctive or emerging.";

/**
 * Classify candidate grocery concepts → kind, cached FROZEN on goals.groceryKinds.
 * Returns a map keyed by conceptKey(concept). LLM only for unseen concepts.
 */
export async function classifyGroceryConcepts(ws: WorkspaceRow, concepts: string[]): Promise<Record<string, GroceryKind>> {
  const wsCached = ((ws.goals as { groceryKinds?: GroceryKinds } | null)?.groceryKinds?.assign ?? {}) as Record<string, GroceryKind>;
  const out: Record<string, GroceryKind> = {};
  const keys = concepts.map(conceptKey).filter(Boolean);
  const globalCached = await vocabGet<{ kind: GroceryKind }>(ws.vertical, "grocery_kind", keys);
  const lookup = (k: string): GroceryKind | undefined => globalCached[k]?.kind ?? wsCached[k];
  const need = new Map<string, string>(); // conceptKey → display concept (unique)
  for (const c of concepts) {
    const k = conceptKey(c); if (!k) continue;
    const hit = lookup(k);
    if (hit) { out[k] = hit; continue; }
    if (!need.has(k)) need.set(k, c);
  }
  if (!need.size || !isLlmConfigured()) return out;

  const list = [...need.entries()];
  const text = list.map(([, c], i) => `${i}\t${c}`).join("\n");
  try {
    const { data } = await getLlm().callStructured<{ map: { i: number; kind: GroceryKind }[] }>({
      system: SYSTEM, text, schema: SCHEMA, tier: "classify", maxTokens: 3000,
    });
    const byI = new Map((Array.isArray(data.map) ? data.map : []).map((m) => [m.i, m.kind]));
    const newAssign: Record<string, GroceryKind> = {};
    list.forEach(([key], i) => { const kind = byI.get(i); if (kind) { out[key] = kind; newAssign[key] = kind; } });
    if (Object.keys(newAssign).length) {
      // persist to the GLOBAL vocabulary first (frozen); fall back to per-workspace
      // goals when the table isn't available (pre-migration = current behavior).
      const globalEntries = Object.fromEntries(Object.entries(newAssign).map(([k, v]) => [k, { kind: v }]));
      if (!(await vocabPut(ws.vertical, "grocery_kind", globalEntries))) {
        const svc = createServiceClient();
        const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
        const prev = ((cur?.goals as { groceryKinds?: GroceryKinds } | null)?.groceryKinds?.assign ?? {}) as Record<string, GroceryKind>;
        const merged = { ...newAssign, ...prev }; // existing wins → frozen
        await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), groceryKinds: { assign: merged, at: new Date().toISOString() } } }).eq("id", ws.id);
      }
    }
  } catch { /* leave unclassified → treated as 'other' (dropped) by caller */ }
  return out;
}
