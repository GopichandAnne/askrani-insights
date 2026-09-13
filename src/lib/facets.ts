import { createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Auto-facet detection — what a business ACTUALLY sells, read from its own category
 * and offerings, not a single strict vertical. Many local businesses do both: a desi
 * restaurant also sells groceries/sweets (e.g. Foodistaan); a desi grocery has a
 * deli/hot-food counter (e.g. Man Pasand's category is literally "Imported Food,
 * Delis"; Desi Brothers sells "Chai + Butter Khari"). Detecting this lets the system
 * watch and compare a hybrid in EACH facet instead of forcing one — the "intelligent
 * like a human" behavior.
 *
 * Cached on goals.facets. Additive to the known vertical: the workspace's own vertical
 * is always kept; detection only ADDS a second facet when the evidence shows it, so a
 * thin-data business simply stays single-facet (never wrongly stripped).
 */

export type Facet = "restaurant" | "grocery";
export interface Facets { verticals: Facet[]; at: string; empty?: boolean }

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    prepared_food: { type: "boolean", description: "sells COOKED food to eat — a restaurant, cafe, hot-food/chaat counter, deli kitchen (biryani, dosa, momos, chai + snacks…)" },
    groceries: { type: "boolean", description: "sells PACKAGED groceries, fresh produce, or pantry staples to take home (dals, flour, masalas, vegetables, frozen…)" },
  },
  required: ["prepared_food", "groceries"],
};
const SYSTEM =
  "You classify what a local business SELLS, from its category and a sample of its offerings. Many businesses do BOTH — decide each independently from the evidence:\n" +
  "- prepared_food = TRUE if it sells cooked food to eat (dishes, biryani/dosa/momos, a chai + snacks or deli/hot counter).\n" +
  "- groceries = TRUE if it sells packaged goods, produce, or pantry staples to take home (branded dals/flour/masalas, vegetables, frozen items).\n" +
  "A desi grocery with a small hot-food/deli counter is BOTH. A restaurant that also sells retail groceries/sweets is BOTH. If the offerings clearly show only one, set only that one true. Judge from evidence, not the name alone.";

const primaryOf = (ws: WorkspaceRow): Facet => (ws.vertical === "grocery" ? "grocery" : "restaurant");

/** Detect a workspace's business facets from its category + offerings. Returns a
 *  report (does not persist — the warm pass / getOrMakeFacets persists it). */
export async function generateFacets(ws: WorkspaceRow, db?: RlsClient): Promise<Facets> {
  const at = new Date().toISOString();
  const primary = primaryOf(ws);
  const fallback: Facets = { verticals: [primary], at };
  if (!isLlmConfigured()) return fallback;

  const svc = db ?? createServiceClient();
  const ids = await workspaceBusinessIds(ws, svc);
  const tid = ids.targetId;
  if (!tid) return fallback; // area workspaces have no single target — keep primary

  const { data: biz } = await svc.from("business").select("canonical_name, category, subcategory").eq("id", tid).maybeSingle();
  const { data: offs } = await svc.from("offer").select("entity_text").eq("business_id", tid).limit(60);
  const items = [...new Set(((offs ?? []) as { entity_text: string | null }[]).map((o) => String(o.entity_text ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 40);
  const cat = [(biz as { category?: string })?.category, (biz as { subcategory?: string })?.subcategory].filter(Boolean).join(" / ");
  if (!items.length && !cat) return fallback; // no evidence → keep the known vertical

  try {
    const { data } = await getLlm().callStructured<{ prepared_food: boolean; groceries: boolean }>({
      system: SYSTEM,
      text: `Business: "${ws.name}"\nCategory: ${cat || "(unknown)"}\nOfferings:\n${items.map((i) => `- ${i}`).join("\n") || "(none listed)"}`,
      schema: SCHEMA, tier: "classify", maxTokens: 300,
    });
    const detected: Facet[] = [];
    if (data.prepared_food) detected.push("restaurant");
    if (data.groceries) detected.push("grocery");
    // Never drop the known vertical; only ADD a detected second facet.
    const verticals = [...new Set<Facet>([primary, ...detected])];
    return { verticals, at };
  } catch {
    return fallback;
  }
}

/** Cached facets for a workspace (goals.facets, refreshed weekly), computing +
 *  persisting on a cold/stale cache. Consumers (detector, monitoring) call this. */
export async function getOrMakeFacets(ws: WorkspaceRow, db?: RlsClient, maxAgeDays = 7): Promise<Facet[]> {
  const cached = (ws.goals as { facets?: Facets } | null)?.facets;
  if (cached?.verticals?.length && cached.at && Date.now() - new Date(cached.at).getTime() < maxAgeDays * 86_400_000) {
    return cached.verticals;
  }
  const report = await generateFacets(ws, db);
  try {
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), facets: report } }).eq("id", ws.id);
  } catch { /* return the report even if persistence fails */ }
  return report.verticals;
}

export const facetsIsGood = (v: Facets | null | undefined): boolean => !!v?.verticals?.length;
