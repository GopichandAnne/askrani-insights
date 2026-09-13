import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { isLlmConfigured } from "@/lib/extraction/llm";
import { resolveConcepts } from "@/lib/conceptcanon";
import { resolveEntities, resolveNameToBrand, type EntityRecord } from "@/lib/entityresolve";
import { rivalStandingCaps, targetStandingCaps } from "@/lib/standingoffers";
import { conceptKey } from "@/lib/conceptcanon";
import { readSaturation } from "@/lib/saturation";
import { classifyGroceryConcepts, GROCERY_OPPORTUNITY, type GroceryKind } from "@/lib/groceryflags";
import { flyerKviGaps, flyerKviLeads, type FlyerDeal } from "@/lib/kviprices";
import { inferUnitBasis } from "@/lib/unitbasis";
import { nearestOccasion } from "@/lib/occasions";
import { getOrMakeFacets } from "@/lib/facets";
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
export interface PriceWin { item: string; youPerBase: number; marketMedian: number; underPct: number; family: string; beats: number }
export interface FallingBehind {
  flags: FallingBehindFlag[];
  qualityBars: string[]; // execution complaints routed OUT of opportunities (context)
  priceWins: PriceWin[];  // grocery: staples you beat the market on (a promotable strength)
  eventsRead: number;
  at: string;
  freshestAt?: string | null; // most recent day any tracked signal was seen (data-freshness)
  empty?: boolean;
  failed?: boolean;
}

const KINDS = ["deal", "demand", "winning_format", "breakout"] as const;
const empty = (at: string, failed = false): FallingBehind => ({ flags: [], qualityBars: [], priceWins: [], eventsRead: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateFallingBehind(ws: WorkspaceRow, db?: RlsClient): Promise<FallingBehind> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());

  const now = new Date();
  const FEST_WINDOW = 75; // days: a festival is an opportunity only within this run-up
  const { data: rows } = await supabase
    .from("market_event")
    .select("kind,rival,title,first_seen_on,last_seen_on")
    .eq("workspace_id", ws.id)
    .limit(600);
  const ev = ((rows ?? []) as { kind: string; rival: string | null; title: string; first_seen_on: string; last_seen_on: string | null }[])
    .filter((r) => (KINDS as readonly string[]).includes(r.kind) && clean(r.title));
  // Data freshness — the most recent day any tracked signal was seen. Surfaced so a
  // brief/card can say "as of X" rather than implying everything is live today.
  const freshestAt = ev.map((r) => r.last_seen_on || r.first_seen_on).filter(Boolean).sort().slice(-1)[0] ?? null;
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

  interface Agg { concept: string; rivals: Map<string, string>; promo: Set<string>; standing: Set<string>; offeringDates: Set<string>; qualityHits: number; supplyEx: string[]; demandEx: string[]; dates: Set<string>; occ: { name: string; inDays: number } | null }
  const byC = new Map<string, Agg>();
  const getAgg = (concept: string): Agg => {
    const key = concept.toLowerCase().trim();
    let a = byC.get(key);
    if (!a) { a = { concept: clean(concept), rivals: new Map(), promo: new Set(), standing: new Set(), offeringDates: new Set(), qualityHits: 0, supplyEx: [], demandEx: [], dates: new Set(), occ: null }; byC.set(key, a); }
    return a;
  };
  // Resolve a festival/occasion mention to the SOONEST still-relevant occurrence for
  // this aggregate — so a concept fed by a past Rakhi promo AND an upcoming Ganesh one
  // reframes to Ganesh, and one fed only by past occasions ends up with occ=null (dropped).
  const noteOccasion = (a: Agg, title: string) => {
    const o = nearestOccasion(title, now);
    if (!o || o.inDays < -3 || o.inDays > FEST_WINDOW) return; // past or too far out
    if (!a.occ || o.inDays < a.occ.inDays) a.occ = { name: o.name, inDays: o.inDays };
  };

  ev.forEach((r, i) => {
    const m = tags[i]; if (!m?.concept) return;
    const a = getAgg(m.concept);
    a.dates.add(r.first_seen_on);
    noteOccasion(a, clean(r.title));
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

  // Brand-level totals + menu coverage for the saturation estimator.
  const competitorBrands = new Set<string>();
  for (const c of competitors) { const b = res.brandOf.get(c.id); if (b) competitorBrands.add(b); }
  const menuCoveredBrands = new Set<string>();
  for (const bid of Object.keys(capsByBiz)) { const b = res.brandOf.get(bid); if (b) menuCoveredBrands.add(b); }
  const totalBrands = competitorBrands.size, coveredN = menuCoveredBrands.size;

  // Facet-aware: a business isn't one strict vertical. A restaurant that also sells
  // groceries (Foodistaan) or a grocery with a deli/hot counter (Man Pasand) is BOTH,
  // so we run BOTH analyses within the one workspace and route EACH concept by its
  // nature — grocery-opportunity concepts (festival/trending/specialty/promotion) get
  // the grocery treatment, restaurant-style moves get the restaurant treatment. Pure
  // verticals resolve to a single facet and behave exactly as before.
  const facets = await getOrMakeFacets(ws, supabase);
  const hasGrocery = facets.includes("grocery");
  const hasFood = facets.includes("restaurant");
  // Grocery concept classification (only when the business has a grocery facet): keeps
  // real grocery openings, drops commodity staples ("2 rivals sell flour") + facility gripes.
  const gKind: Record<string, GroceryKind> = hasGrocery
    ? await classifyGroceryConcepts(ws, [...byC.values()].map((a) => a.concept))
    : {};

  const flags: FallingBehindFlag[] = [];
  const qualityBars: string[] = [];
  let priceWins: PriceWin[] = [];
  for (const a of byC.values()) {
    // the owner already offers this (menu-derived or owner-confirmed) → not an opening
    if (targetConcepts.has(conceptKey(a.concept))) continue;
    const rivalCount = a.rivals.size;
    const promoCount = a.promo.size;
    const demandDates = a.offeringDates.size;
    const recurring = demandDates >= 2;
    // execution-only concept (gripes, nobody "supplies" it, no offering wish) → a bar, not an opportunity
    if (a.qualityHits && !demandDates && !rivalCount) { qualityBars.push(a.concept); continue; }

    // Festival/occasion opportunities live only in the RUN-UP. If this concept is
    // festival-shaped, require a still-upcoming occasion — a past one (a Rakhi promo
    // in September) is noise, not an opening. Kept ones are reframed + urgency-ranked below.
    // Which facet is THIS concept? A grocery-opportunity kind → grocery nature; a
    // commodity/facility → grocery noise (drop); anything else → restaurant-style move.
    const gk = hasGrocery ? (gKind[conceptKey(a.concept)] ?? "other") : undefined;
    const isGroceryConcept = gk !== undefined && GROCERY_OPPORTUNITY.has(gk);

    const isFestival = (hasGrocery && gk === "festival") || /festiv|occasion/i.test(a.concept);
    if (isFestival && !a.occ) continue;

    const sat = readSaturation(rivalCount, totalBrands, coveredN);
    const openBoost = Math.round((1 - sat.saturation) * 28); // the more open the gap, the better the opening

    let tag: FbTag | null = null, score = 0;
    if (isGroceryConcept) {
      // grocery opening (festival basket / trending / distinctive specialty / promotion)
      if (rivalCount < 1 && demandDates < 1) continue;      // need some observed evidence
      if (gk === "trending") {
        // an emerging product few carry yet = early-mover opening
        tag = "demand_moving"; score = 110 + demandDates * 6 + rivalCount * 4 + openBoost;
      } else {
        // festival basket / specialty / category promotion you're not matching
        if (sat.state === "saturated") continue;            // everyone does it → table stakes
        tag = "behind"; score = 68 + promoCount * 10 + rivalCount * 4 + Math.floor(openBoost / 2) + (gk === "festival" ? 12 : 0);
      }
    } else if (hasGrocery && (gk === "commodity" || gk === "facility")) {
      continue; // grocery staple/facility noise → not an opening
    } else if (hasFood && demandDates >= 1) {
      if (sat.state === "early" || sat.state === "contested") {
        // demand + an OPEN supply gap (few/some rivals) = the prime opening
        tag = "demand_moving"; score = 120 + demandDates * 6 + (recurring ? 20 : 0) + openBoost + promoCount * 8;
      } else if (sat.state === "saturated") {
        // demand but nearly everyone already does it → table stakes, weak (owner likely has it too)
        tag = "behind"; score = 50 + promoCount * 8;
      } else if (recurring) {
        // demand but no observed adopter: a real virgin gap only if we can SEE menus (visible);
        // otherwise it's an observation gap → keep as a low-confidence early signal.
        tag = "demand_gap"; score = sat.visible ? 58 + demandDates * 6 : 30 + demandDates * 4;
      }
    } else if (hasFood && promoCount >= 2 && sat.state !== "saturated") {
      // no demand, but rivals are actively PROMOTING it and the gap isn't saturated → you're behind
      tag = "behind"; score = 80 + promoCount * 12 + Math.floor(openBoost / 2);
    }
    // everything else (grocery-only "other", menu-only, saturated-no-demand) → drop.
    if (!tag) continue;

    // Reframe a festival flag to the specific upcoming occasion + timing, and rank it
    // by urgency (sooner = higher) so the run-up you can still act on floats up.
    let displayConcept = a.concept;
    if (isFestival && a.occ) {
      const dd = a.occ.inDays;
      displayConcept = `${a.occ.name} — ${dd <= 0 ? "happening now" : `in ${dd} day${dd === 1 ? "" : "s"}`}`;
      score += Math.max(0, 34 - Math.floor(dd / 2));
    }

    flags.push({
      concept: displayConcept, tag,
      rivals: [...a.rivals.values()].slice(0, 6), rivalCount,
      demandDates, recurring,
      evidence: a.supplyEx[0], demandExample: a.demandEx[0],
      seen: [...a.dates].sort(), score,
    });
  }

  // Grocery G1: KVI price-position from flyer prices (goals.flyerDeals / myFlyerDeals) —
  // "you're priced above market on <staple>". Uses priceCanon to collapse item-name
  // variants and entity resolution to dedupe rival brands; only fires on the target's
  // own price + >=2 rival brands + a material over-market gap. Never excluded by
  // target-gap (a price gap on something you DO sell is the whole point). Runs for any
  // business with a grocery facet — incl. a hybrid restaurant that sells groceries.
  if (hasGrocery) {
    const goals = (ws.goals as Record<string, unknown> | null) ?? {};
    const myDeals = ((goals.myFlyerDeals as { deals?: FlyerDeal[] } | null)?.deals ?? []) as FlyerDeal[];
    const compDeals = ((goals.flyerDeals as { deals?: FlyerDeal[] } | null)?.deals ?? []) as FlyerDeal[];
    const priceCanonMap = ((goals.priceCanon as { canon?: Record<string, string> } | null)?.canon ?? {}) as Record<string, string>;
    const normItem = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\b\d+(?:\.\d+)?\s*(?:lbs?|oz|kg|g|l|ml|ct|pk|pack|gallon|quart|pint|dozen)\b/g, " ").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
    const canonItem = (it: string) => { const n = normItem(it); return priceCanonMap[n] ?? n; };
    // infer how each staple is sold (produce→lb, herb→bunch, eggs→dozen…) so implicit
    // flyer prices compare on the right basis, cached on goals.unitBasis
    const distinctItems = [...new Set([...myDeals, ...compDeals].map((d) => canonItem(String(d.item ?? ""))).filter((c) => c.length >= 3))];
    const basisMap = await inferUnitBasis(ws, distinctItems);
    const priceGaps = flyerKviGaps(myDeals, compDeals, targetKey, canonItem, brandOfRival, basisMap, { minOverPct: 12, minRivals: 2 });
    // the positive inverse — staples you beat the market on (a promotable strength)
    priceWins = flyerKviLeads(myDeals, compDeals, targetKey, canonItem, brandOfRival, basisMap, { minUnderPct: 12, minRivals: 2 })
      .slice(0, 6)
      .map((w) => ({ item: w.canon, youPerBase: w.targetPerBase, marketMedian: w.marketMedian, underPct: w.underPct, family: w.family, beats: w.beats.length }));
    for (const g of priceGaps.slice(0, 4)) {
      const per = g.family === "weight" ? "/lb" : g.family === "volume" ? "/floz" : g.family === "count" ? "/ct" : "";
      flags.push({
        concept: `Priced above market: ${g.canon}`, tag: "behind",
        rivals: g.rivalsCheaper.slice(0, 6), rivalCount: g.rivalsCheaper.length,
        demandDates: 0, recurring: false,
        evidence: `You ~$${g.targetPerBase.toFixed(2)}${per} vs market ~$${g.marketMedian.toFixed(2)}${per} (+${g.overPct}%); cheapest ${g.cheapest.brand} $${g.cheapest.perBase.toFixed(2)}${per}`,
        seen: [], score: 100 + Math.min(60, g.overPct),
      });
    }
  }

  flags.sort((x, y) => y.score - x.score);
  if (!flags.length && !qualityBars.length && !priceWins.length) return { ...empty(at), freshestAt };
  return { flags: flags.slice(0, 8), qualityBars: qualityBars.slice(0, 12), priceWins, eventsRead: ev.length, at, freshestAt };
}

export function fallingBehindIsGood(r: FallingBehind): boolean {
  if (r.failed) return false;
  return !!(r.flags.length || r.priceWins.length || r.empty);
}

export function getOrMakeFallingBehind(ws: WorkspaceRow, maxAgeHours = 24): Promise<FallingBehind> {
  return staleCached(ws, "fallingBehind", maxAgeHours, () => generateFallingBehind(ws), { isValid: (c) => !c.failed });
}
