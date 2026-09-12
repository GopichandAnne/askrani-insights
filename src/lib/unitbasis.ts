import { createServiceClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { vocabGet, vocabPut } from "@/lib/vocab";
import type { WorkspaceRow } from "@/lib/workspace";
import type { UnitFamily } from "@/lib/priceunits";

/**
 * Unit-basis intelligence for grocery price comparison. Flyer prices carry no
 * explicit unit ("Okra $0.99", "Cilantro $3"), so v1 blindly assumed per-lb — wrong
 * for herbs (per bunch), eggs (per dozen), milk (by volume). This infers, per item,
 * HOW it's normally sold at US retail — family (weight / volume / count) + a basis
 * label (lb, bunch, dozen, each, …) — so a price is interpreted on the right basis
 * and only ever compared to the same basis (a per-bunch price never vs a per-lb one),
 * and an implicit produce price unifies with an explicit-pack listing of the same item.
 *
 * Cached FROZEN + additive, keyed by canonical item (a basis is a stable property of
 * the product), so the LLM only classifies items it hasn't seen. Reads the GLOBAL
 * per-vertical vocabulary first (concept_vocab, kind='unit_basis') then this
 * workspace's own goals.unitBasis as fallback, and writes new bases to the global
 * table when available — so a NEW grocery store inherits established bases instantly.
 * Degrades to per-workspace when migration 0076 isn't applied.
 */

export interface UnitBasis { family: UnitFamily; basis: string }
interface UnitBasisCache { assign: Record<string, UnitBasis>; at: string }

const keyOf = (canonItem: string) => String(canonItem ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    map: {
      type: "array", description: "One entry per input item.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          i: { type: "integer" },
          family: { type: "string", enum: ["weight", "volume", "count"] },
          basis: { type: "string", description: "lb | oz | floz | l | each | bunch | dozen | pack" },
        },
        required: ["i", "family", "basis"],
      },
    },
  },
  required: ["map"],
};

const SYSTEM =
  "For each GROCERY item, state how it is normally sold at US retail so prices can be compared on the right basis. Return family + basis:\n" +
  "- weight (basis lb/oz): loose produce (okra, tomato, onion, potato, chili), meat/seafood by weight, rice/flour/dal/sugar/nuts sold loose or in bags.\n" +
  "- volume (basis floz/l/gallon): milk, juice, oil sold by volume, yogurt drinks, water.\n" +
  "- count (basis each/bunch/dozen/pack): leafy herbs & greens sold in a BUNCH (cilantro, methi, green onion, spinach bunch, curry leaves); eggs by DOZEN; a whole head/unit (cauliflower, cabbage, lettuce, coconut, lemon, bread loaf) by EACH; canned/boxed/bottled goods and multipacks by PACK.\n" +
  "Pick the DOMINANT US convention for the item as named. If a bag/box SIZE is in the name (e.g. '20lb', '1L'), still give the underlying family. Be decisive.";

/**
 * Infer (cached) the unit basis for a set of canonical grocery items. Returns a map
 * keyed by canonical item. LLM only for items not already cached.
 */
export async function inferUnitBasis(ws: WorkspaceRow, canonItems: string[]): Promise<Record<string, UnitBasis>> {
  const wsCached = ((ws.goals as { unitBasis?: UnitBasisCache } | null)?.unitBasis?.assign ?? {}) as Record<string, UnitBasis>;
  const out: Record<string, UnitBasis> = {};
  const keys = canonItems.map(keyOf).filter(Boolean);
  const globalCached = await vocabGet<UnitBasis>(ws.vertical, "unit_basis", keys);
  const lookup = (k: string): UnitBasis | undefined => globalCached[k] ?? wsCached[k];
  const need = new Map<string, string>(); // key → display item
  for (const it of canonItems) {
    const k = keyOf(it); if (!k) continue;
    const hit = lookup(k);
    if (hit) { out[k] = hit; continue; }
    if (!need.has(k)) need.set(k, it);
  }
  if (!need.size || !isLlmConfigured()) return out;

  // BATCH (like concept resolution): a grocery flyer can have hundreds of distinct
  // items; one giant call overflows and fails → nothing caches → fails forever.
  const list = [...need.entries()];
  const BATCH = 80;
  const newAssign: Record<string, UnitBasis> = {};
  for (let start = 0; start < list.length; start += BATCH) {
    const chunk = list.slice(start, start + BATCH);
    const text = chunk.map(([, it], i) => `${i}\t${it}`).join("\n");
    try {
      const { data } = await getLlm().callStructured<{ map: { i: number; family: UnitFamily; basis: string }[] }>({
        system: SYSTEM, text, schema: SCHEMA, tier: "classify", maxTokens: 4000,
      });
      const byI = new Map((Array.isArray(data.map) ? data.map : []).map((m) => [m.i, m]));
      chunk.forEach(([key], i) => {
        const r = byI.get(i); if (!r) return;
        const family: UnitFamily = r.family === "weight" || r.family === "volume" || r.family === "count" ? r.family : "count";
        out[key] = { family, basis: String(r.basis ?? "").trim() || "each" };
        newAssign[key] = out[key];
      });
    } catch { /* skip this batch; others still advance the cache */ }
  }
  if (Object.keys(newAssign).length) {
    try {
      // persist to the GLOBAL vocabulary first (frozen); fall back to per-workspace
      // goals when the table isn't available (pre-migration = current behavior).
      if (!(await vocabPut(ws.vertical, "unit_basis", newAssign))) {
        const svc = createServiceClient();
        const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
        const prev = ((cur?.goals as { unitBasis?: UnitBasisCache } | null)?.unitBasis?.assign ?? {}) as Record<string, UnitBasis>;
        const merged = { ...newAssign, ...prev }; // existing wins → frozen
        await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), unitBasis: { assign: merged, at: new Date().toISOString() } } }).eq("id", ws.id);
      }
    } catch { /* tags resolved this run; persistence retries next run */ }
  }
  return out;
}

export { keyOf as unitBasisKey };
