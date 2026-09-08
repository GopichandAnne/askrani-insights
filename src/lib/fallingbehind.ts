import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * "You're falling behind" — the V2 defensive opportunity detector (P0.5).
 *
 * Reads the append-only market_event log (the moves/demand we already mine per
 * cycle) and, in one LLM pass, canonicalizes every signal onto a SHARED concept
 * space at action-granularity — so a competitor's promo ("$0 delivery") and a
 * customer's review-wish ("free delivery") land on the same concept and can be
 * cross-referenced. Then it triangulates:
 *   • supply activity — how many DISTINCT rivals (entity-deduped) run a move, and
 *   • offering-demand — review-mined wishes for something to ADD/promote
 * into ranked flags. Two hard-won rules from the real-data proof (2026-09-08):
 *   1. demand is SPLIT into "offering" (opportunity) vs "quality" (execution
 *      gripes — routed OUT to quality bars, never an opportunity), and
 *   2. because our competitor coverage is promo-events-only, the supply count is
 *      biased LOW, so an offering-demand item with few/no observed rivals stays
 *      LOW-confidence ("early signal"), never an invest-stakes flag.
 *
 * Grounded strictly in market_event — no new scrape, one LLM call. Hardened like
 * the other pillars: a failed AI read is flagged (never cached final) so it
 * self-heals next refresh. Concept clustering re-runs per regeneration for now
 * (a cached canonical map, priceCanon-style, is a documented follow-up).
 */

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();

// Crude entity normalizer — merges "Shah Ghouse Biryani | Austin" → "shah ghouse
// biryani", branch/city suffixes and punctuation. A Fellegi-Sunter resolver with
// geo/phone/address splitters is the eventual upgrade; this held on real data.
const canonRival = (s: string) =>
  (s || "").toLowerCase().replace(/\s*[|\-–]\s*(austin|cedar park|round rock|texas|tx)\b.*$/i, "").replace(/[^a-z0-9]+/g, " ").trim();

export type FbTag = "behind" | "demand_moving" | "demand_gap";
export interface FallingBehindFlag {
  concept: string;
  tag: FbTag;
  rivals: string[];      // display names of distinct rivals doing it
  rivalCount: number;
  demandDates: number;   // distinct dates an offering-wish appeared
  recurring: boolean;    // demand seen on ≥2 dates
  evidence?: string;     // one supply example ("Rival: title")
  demandExample?: string;
  seen: string[];        // distinct dates
  score: number;
}
export interface FallingBehind {
  flags: FallingBehindFlag[];
  qualityBars: string[]; // execution complaints routed OUT of opportunities (context)
  eventsRead: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    map: {
      type: "array",
      description: "One entry per numbered input line.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          i: { type: "integer", description: "the line number" },
          concept: { type: "string", description: "action-granularity concept label, REUSED across demand and supply lines that describe the same owner move" },
          demand_type: { type: "string", enum: ["offering", "quality", "other", "na"], description: "for [demand] lines only; 'na' for every non-demand line" },
        },
        required: ["i", "concept", "demand_type"],
      },
    },
  },
  required: ["map"],
};

const SYSTEM =
  "You canonicalize local-business market signals for a competitive detector. For EACH numbered input line return one `concept` and a `demand_type`.\n" +
  "CONCEPT = action granularity: the level where one concept = one distinct move an owner could make. Use the SAME concept label whether a phrase came from a customer review (demand) or a competitor promo (supply), so they can be matched. Examples that MUST share a concept: 'Catering for large events' + 'party trays 20% off' + 'large-group combo' => 'catering / large-group orders'; '$0 delivery fee first order' + 'wish delivery were free' => 'free/discounted delivery'; 'new veg thali' + 'wish they had more vegetarian' => 'vegetarian options'. Group festival/occasion specials as 'festival / occasion special'; individual grocery produce items as 'grocery produce assortment'.\n" +
  "demand_type (ONLY for [demand] lines; use 'na' otherwise): 'offering' = a wish for a PRODUCT/SERVICE/FORMAT/CUISINE/OCCASION the business could ADD or promote (an opportunity); 'quality' = a complaint about EXECUTION of existing operations (cleanliness, speed, consistency, spice accuracy, freshness, service — NOT an opportunity); 'other' = neither.";

const KINDS = ["deal", "demand", "winning_format", "breakout"] as const;
const empty = (at: string, failed = false): FallingBehind => ({ flags: [], qualityBars: [], eventsRead: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateFallingBehind(ws: WorkspaceRow, db?: RlsClient): Promise<FallingBehind> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());

  const { data: rows } = await supabase
    .from("market_event")
    .select("kind,rival,title,first_seen_on")
    .eq("workspace_id", ws.id)
    .limit(600);
  const ev = ((rows ?? []) as { kind: string; rival: string | null; title: string; first_seen_on: string }[])
    .filter((r) => (KINDS as readonly string[]).includes(r.kind) && clean(r.title));
  if (!ev.length) return empty(at);
  if (!isLlmConfigured()) return empty(at);

  const items = ev.map((r, i) => `${i}\t[${r.kind}] ${clean(r.title).slice(0, 120)}`).join("\n");
  const targetKey = canonRival(ws.name);

  let map: { i: number; concept: string; demand_type: string }[];
  try {
    const call = () => getLlm().callStructured<{ map: typeof map }>({ system: SYSTEM, text: items, schema: SCHEMA, tier: "classify", maxTokens: 8000 });
    const { data } = await call().catch(() => call());
    map = Array.isArray(data.map) ? data.map : [];
    if (!map.length) return empty(at, true);
  } catch {
    return empty(at, true);
  }
  const info = new Map(map.map((m) => [m.i, m]));

  interface Agg { concept: string; rivals: Map<string, string>; offeringDates: Set<string>; qualityHits: number; supplyEx: string[]; demandEx: string[]; dates: Set<string> }
  const byC = new Map<string, Agg>();
  ev.forEach((r, i) => {
    const m = info.get(i); if (!m?.concept) return;
    const key = m.concept.toLowerCase().trim(); if (!key) return;
    const a: Agg = byC.get(key) ?? { concept: clean(m.concept), rivals: new Map<string, string>(), offeringDates: new Set<string>(), qualityHits: 0, supplyEx: [], demandEx: [], dates: new Set<string>() };
    a.dates.add(r.first_seen_on);
    if (r.kind === "demand") {
      if (m.demand_type === "offering") { a.offeringDates.add(r.first_seen_on); if (a.demandEx.length < 2) a.demandEx.push(clean(r.title)); }
      else if (m.demand_type === "quality") a.qualityHits++;
    } else {
      const ck = canonRival(r.rival || "");
      if (ck && ck !== targetKey && !a.rivals.has(ck)) a.rivals.set(ck, clean(r.rival || ""));
      if (a.supplyEx.length < 2) a.supplyEx.push(`${clean(r.rival || "A rival")}: ${clean(r.title).slice(0, 70)}`);
    }
    byC.set(key, a);
  });

  const flags: FallingBehindFlag[] = [];
  const qualityBars: string[] = [];
  for (const a of byC.values()) {
    const rivalCount = a.rivals.size;
    const demandDates = a.offeringDates.size;
    const recurring = demandDates >= 2;
    // execution-only concept (gripes, nobody "supplies" it, no offering wish) → a bar, not an opportunity
    if (a.qualityHits && !demandDates && !rivalCount) { qualityBars.push(a.concept); continue; }

    let tag: FbTag | null = null, score = 0;
    if (demandDates >= 1 && rivalCount >= 1) { tag = "demand_moving"; score = 120 + rivalCount * 12 + demandDates * 6 + (recurring ? 20 : 0); }
    else if (rivalCount >= 2) { tag = "behind"; score = 70 + rivalCount * 12; }
    else if (recurring) { tag = "demand_gap"; score = 45 + demandDates * 6; }
    if (!tag) continue;

    flags.push({
      concept: a.concept, tag,
      rivals: [...a.rivals.values()].slice(0, 6), rivalCount,
      demandDates, recurring,
      evidence: a.supplyEx[0], demandExample: a.demandEx[0],
      seen: [...a.dates].sort(), score,
    });
  }
  flags.sort((x, y) => y.score - x.score);
  if (!flags.length && !qualityBars.length) return empty(at);
  return { flags: flags.slice(0, 8), qualityBars: qualityBars.slice(0, 12), eventsRead: ev.length, at };
}

export function fallingBehindIsGood(r: FallingBehind): boolean {
  if (r.failed) return false;
  return !!(r.flags.length || r.empty);
}

export function getOrMakeFallingBehind(ws: WorkspaceRow, maxAgeHours = 24): Promise<FallingBehind> {
  return staleCached(ws, "fallingBehind", maxAgeHours, () => generateFallingBehind(ws), { isValid: (c) => !c.failed });
}
