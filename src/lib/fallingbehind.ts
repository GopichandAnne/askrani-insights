import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { isLlmConfigured } from "@/lib/extraction/llm";
import { resolveConcepts } from "@/lib/conceptcanon";
import { resolveEntities, resolveNameToBrand, type EntityRecord } from "@/lib/entityresolve";
import { rivalStandingCaps, targetStandingCaps } from "@/lib/standingoffers";
import { conceptKey } from "@/lib/conceptcanon";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

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
 * Grounded strictly in market_event — no new scrape. Concept assignment goes
 * through the FROZEN, additive concept-canon map (lib/conceptcanon.ts), so the
 * output is stable run-to-run and the LLM only fires for surface forms it hasn't
 * seen. Hardened like the other pillars: a failed AI read is flagged (never cached
 * final) so it self-heals next refresh.
 */

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();

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

  // Fellegi-Sunter entity resolution over the workspace's businesses (name + phone
  // + geo + address), so rival names dedupe to canonical BRANDS — branches of one
  // chain count once, and geo/phone splitters keep distinct look-alikes separate.
  const ids = await workspaceBusinessIds(ws, supabase);
  const { data: bizRows } = await supabase.from("business").select("id, canonical_name, phone, attributes").in("id", ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"]);
  const records: EntityRecord[] = ((bizRows ?? []) as { id: string; canonical_name: string; phone: string | null; attributes: Record<string, unknown> | null }[])
    .map((b) => ({ id: b.id, name: b.canonical_name, phone: b.phone, address: (b.attributes?.address as string) ?? null, geo: (b.attributes?.geo as { lat: number; lng: number }) ?? null }));
  const res = resolveEntities(records);
  const brandCache = new Map<string, string>();
  const brandOfRival = (name: string): string => {
    const key = clean(name).toLowerCase();
    let b = brandCache.get(key); if (b == null) { b = resolveNameToBrand(name, res); brandCache.set(key, b); }
    return b;
  };
  const targetKey = brandOfRival(ws.name);

  // Standing offerings: distil each competitor's menu into a few move-level
  // capabilities (cached), so a move a rival OFFERS but hasn't promoted lately still
  // counts as supply — the fix for demand-gaps that were really observation gaps.
  const competitors = ((bizRows ?? []) as { id: string; canonical_name: string }[])
    .filter((b) => brandOfRival(b.canonical_name) !== targetKey)
    .map((b) => ({ id: b.id, name: b.canonical_name }));
  const nameById = new Map(competitors.map((c) => [c.id, c.name]));
  const capsByBiz = await rivalStandingCaps(ws, competitors, supabase);
  const capItems: { businessId: string; text: string }[] = [];
  for (const [bid, caps] of Object.entries(capsByBiz)) for (const cap of caps) capItems.push({ businessId: bid, text: cap });

  // The TARGET's own standing offerings (menu-derived) + owner-confirmed "we do
  // this" (goals.weOffer) → the target-gap: concepts the owner ALREADY offers are
  // not openings, so we exclude them from flags (and this gates invest-stakes).
  const targetCaps = await targetStandingCaps(ws, { id: ids.targetId, name: ws.name }, supabase);
  const weOffer = (((ws.goals as { weOffer?: string[] } | null)?.weOffer) ?? []).map((s) => conceptKey(String(s)));

  // Resolve events + rival standing caps + target caps onto the shared cached
  // concept map (stable run-to-run; LLM only for unseen surface forms). A mature
  // map keeps working even if the LLM is down; only a cold cache + failed yields nothing.
  const { tags, llmFailed } = await resolveConcepts(ws, [
    ...ev.map((r) => ({ kind: r.kind, text: clean(r.title) })),
    ...capItems.map((c) => ({ kind: "offering", text: c.text })),
    ...targetCaps.map((t) => ({ kind: "offering", text: t })),
  ]);
  if (llmFailed && tags.every((t) => !t)) return empty(at, true);
  const capOffset = ev.length;
  const targetOffset = ev.length + capItems.length;

  // concept keys the owner already offers → excluded from flags
  const targetConcepts = new Set<string>(weOffer);
  targetCaps.forEach((_, j) => { const m = tags[targetOffset + j]; if (m?.concept) targetConcepts.add(conceptKey(m.concept)); });

  interface Agg { concept: string; rivals: Map<string, string>; promo: Set<string>; standing: Set<string>; offeringDates: Set<string>; qualityHits: number; supplyEx: string[]; demandEx: string[]; dates: Set<string> }
  const byC = new Map<string, Agg>();
  const getAgg = (concept: string): Agg => {
    const key = concept.toLowerCase().trim();
    let a = byC.get(key);
    if (!a) { a = { concept: clean(concept), rivals: new Map(), promo: new Set(), standing: new Set(), offeringDates: new Set(), qualityHits: 0, supplyEx: [], demandEx: [], dates: new Set() }; byC.set(key, a); }
    return a;
  };

  ev.forEach((r, i) => {
    const m = tags[i]; if (!m?.concept) return;
    const a = getAgg(m.concept);
    a.dates.add(r.first_seen_on);
    if (r.kind === "demand") {
      if (m.demand_type === "offering") { a.offeringDates.add(r.first_seen_on); if (a.demandEx.length < 2) a.demandEx.push(clean(r.title)); }
      else if (m.demand_type === "quality") a.qualityHits++;
    } else {
      const ck = r.rival ? brandOfRival(r.rival) : "";
      if (ck && ck !== targetKey) { if (!a.rivals.has(ck)) a.rivals.set(ck, clean(r.rival || "")); a.promo.add(ck); } // actively promoting
      if (a.supplyEx.length < 2) a.supplyEx.push(`${clean(r.rival || "A rival")}: ${clean(r.title).slice(0, 70)}`);
    }
  });
  // standing offerings → supply presence (brand resolved directly from business id)
  capItems.forEach((c, j) => {
    const m = tags[capOffset + j]; if (!m?.concept) return;
    const brand = res.brandOf.get(c.businessId); if (!brand || brand === targetKey) return;
    const a = getAgg(m.concept);
    if (!a.rivals.has(brand)) a.rivals.set(brand, nameById.get(c.businessId) || "A rival");
    a.standing.add(brand);
    if (a.supplyEx.length < 2) a.supplyEx.push(`${nameById.get(c.businessId) || "A rival"} (on menu): ${c.text}`);
  });

  const C = Math.max(1, competitors.length);
  const flags: FallingBehindFlag[] = [];
  const qualityBars: string[] = [];
  for (const a of byC.values()) {
    // the owner already offers this (menu-derived or owner-confirmed) → not an opening
    if (targetConcepts.has(conceptKey(a.concept))) continue;
    const rivalCount = a.rivals.size;
    const promoCount = a.promo.size;
    const demandDates = a.offeringDates.size;
    const recurring = demandDates >= 2;
    const saturation = rivalCount / C;
    // execution-only concept (gripes, nobody "supplies" it, no offering wish) → a bar, not an opportunity
    if (a.qualityHits && !demandDates && !rivalCount) { qualityBars.push(a.concept); continue; }

    let tag: FbTag | null = null, score = 0;
    if (demandDates >= 1 && rivalCount >= 1) {
      // demand + supply, and STILL a gap while supply is not yet saturated = the real opening
      tag = "demand_moving"; score = 120 + demandDates * 6 + (recurring ? 20 : 0) + Math.round((1 - saturation) * 24) + promoCount * 8;
    } else if (promoCount >= 2) {
      // rivals actively PROMOTING it (not just listing it) → a real "you're behind"
      tag = "behind"; score = 80 + promoCount * 12;
    } else if (rivalCount >= 2) {
      // supply is menu-only (nobody promoting, no demand). Near-universal = table stakes
      // you almost certainly also offer (target offerings unknown) → drop, don't flag.
      if (saturation >= 0.5) continue;
      tag = "behind"; score = 38 + rivalCount * 5;
    } else if (recurring) {
      tag = "demand_gap"; score = 45 + demandDates * 6;
    }
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
