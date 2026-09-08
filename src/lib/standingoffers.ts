import { createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Rivals' STANDING offerings — the supply signal the detector was missing. The
 * "falling behind" pillar originally saw only PROMO events (market_event), so a
 * move a rival offers permanently but hasn't promoted lately (catering on the menu,
 * a kids menu, a dessert section) looked like "0 rivals" — a blind spot that made
 * real gaps read as false virgin opportunities.
 *
 * Competitor menus in the `offer` table are DISH-heavy (hundreds of items), so we
 * do NOT concept-map every dish. Instead one cached LLM pass per competitor distils
 * the menu into a few MOVE-LEVEL capability phrases (action-granularity, same space
 * as the detector's concepts) — "catering / large-group orders", "vegetarian
 * selection", "kids menu", "family / combo packs", "dessert selection" — which then
 * feed the supply side and canonicalize onto the shared concept map.
 *
 * Cached on goals.rivalCaps keyed by business_id, invalidated when the menu size
 * changes. Bounded: only competitors that actually have offers, one small call each.
 */

const SAMPLE = 140; // dishes sampled per competitor menu (enough to reveal capabilities)

export interface RivalCaps { at: string; byBiz: Record<string, { caps: string[]; n: number }> }

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    caps: {
      type: "array", maxItems: 10,
      description: "MOVE-level standing offerings the menu actually evidences — the level of a distinct owner move, NOT individual dishes.",
      items: { type: "string" },
    },
  },
  required: ["caps"],
};

const SYSTEM =
  "You read a local business's MENU / product list and name the MOVE-LEVEL standing offerings a competing owner would care about — the level where one item = one distinct move, NOT individual dishes. Examples (reason from the VERTICAL, don't force these): restaurant → 'catering / large-group orders', 'vegetarian selection', 'kids menu', 'dessert selection', 'family / combo packs', 'breakfast service', 'biryani specialty', 'thali / combo meals'; grocery → 'halal meat counter', 'fresh produce', 'frozen selection', 'festival / pooja assortment', 'bulk staples', 'prepared hot food'. Only list what the items ACTUALLY evidence; omit anything not clearly present. Short phrases, deduplicated, at most ~8.";

/** One LLM pass: menu items → move-level capability phrases (deduped, ≤8). */
async function capsFromMenu(name: string, vertical: string, items: string[]): Promise<string[]> {
  if (items.length < 3) return [];
  try {
    const { data } = await getLlm().callStructured<{ caps: string[] }>({
      system: SYSTEM,
      text: `Business: "${name}" (${vertical}).\nMenu / product items:\n${items.join("\n")}\n\nList its move-level standing offerings.`,
      schema: SCHEMA, tier: "classify", maxTokens: 400,
    });
    return [...new Set((data.caps ?? []).map((s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase()).filter((s) => s.length > 2))].slice(0, 8);
  } catch { return []; }
}

const menuItems = (offs: { entity_text?: string }[] | null): string[] =>
  [...new Set((offs ?? []).map((o) => String(o.entity_text ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, SAMPLE);

/**
 * Build (cached) the move-level standing capabilities for a set of competitors.
 * `db` reads offers (service in warm / rls on request); the cache write always uses
 * a service client. Returns businessId → capability phrases.
 */
export async function rivalStandingCaps(
  ws: WorkspaceRow,
  competitors: { id: string; name: string }[],
  db?: RlsClient,
): Promise<Record<string, string[]>> {
  const supabase = db ?? (await createServiceClient());
  const out: Record<string, string[]> = {};
  if (!competitors.length || !isLlmConfigured()) return out;

  const cached = ((ws.goals as { rivalCaps?: RivalCaps } | null)?.rivalCaps?.byBiz ?? {}) as RivalCaps["byBiz"];
  const fresh: RivalCaps["byBiz"] = {};
  let changed = false;

  for (const c of competitors) {
    const { data: offs, count } = await supabase
      .from("offer").select("entity_text", { count: "exact" }).eq("business_id", c.id).limit(SAMPLE);
    const n = count ?? (offs?.length ?? 0);
    if (!n) continue;

    const prev = cached[c.id];
    if (prev && prev.n === n) { out[c.id] = prev.caps; fresh[c.id] = prev; continue; } // menu unchanged → reuse

    const caps = await capsFromMenu(c.name, ws.vertical, menuItems(offs));
    if (caps.length) { out[c.id] = caps; fresh[c.id] = { caps, n }; changed = true; }
  }

  if (changed) {
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    const report: RivalCaps = { at: new Date().toISOString(), byBiz: fresh };
    await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), rivalCaps: report } }).eq("id", ws.id);
  }
  return out;
}

export interface TargetCaps { at: string; caps: string[]; n: number }

/**
 * The TARGET's own standing offerings — same menu distillation, so the detector
 * can compute the target-gap and DROP "you're falling behind" flags for things the
 * owner already offers. Cached on goals.targetCaps. Returns [] when the owner's
 * menu isn't collected (Desi Circle's offer table is empty) — then the owner-
 * confirmed goals.weOffer is the fallback source of "we already do this".
 */
export async function targetStandingCaps(ws: WorkspaceRow, target: { id: string | null; name: string }, db?: RlsClient): Promise<string[]> {
  if (!target.id || !isLlmConfigured()) return [];
  const supabase = db ?? (await createServiceClient());
  const { data: offs, count } = await supabase.from("offer").select("entity_text", { count: "exact" }).eq("business_id", target.id).limit(SAMPLE);
  const n = count ?? (offs?.length ?? 0);
  const cached = (ws.goals as { targetCaps?: TargetCaps } | null)?.targetCaps;
  if (cached && cached.n === n) return cached.caps;
  if (!n) return [];
  const caps = await capsFromMenu(target.name, ws.vertical, menuItems(offs));
  if (!caps.length) return cached?.caps ?? [];
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), targetCaps: { at: new Date().toISOString(), caps, n } satisfies TargetCaps } }).eq("id", ws.id);
  return caps;
}
