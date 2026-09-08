import { comparablePrice, kviPriceGaps, kviPriceLeads, type KviObservation, type KviGap, type KviLead } from "@/lib/priceunits";
import { unitBasisKey, type UnitBasis } from "@/lib/unitbasis";

/**
 * Grocery G1 wired to the RIGHT price store — goals.flyerDeals (competitor) +
 * goals.myFlyerDeals (target), where the flyer/Google-mined staple prices actually
 * live. (The offer table only holds website-crawl prices, which desi grocers don't
 * publish — the plumbing gap that made G1 look data-blocked.)
 *
 * Flyer deals are {item, price:"$1.99", rival}. Prices carry NO explicit unit, so:
 *   • if the item name has a pack size ("20lb", "1L") → normalize to price-per-unit
 *     via comparablePrice (a trailing bare "lb"/"oz" is read as per-that-unit);
 *   • otherwise treat it as a raw per-listing price (family "listing") — fine for
 *     produce specials, which are uniformly per-lb by convention.
 * Comparison only happens WITHIN the same (canonical item × family), so a per-lb
 * staple is never compared against a raw-listing produce price. Precision-first:
 * gaps need the target's own price + ≥2 rival brands + a material over-market gap.
 */

export interface FlyerDeal { item?: string; price?: string; rival?: string }

const parsePrice = (s?: string): number | null => { const m = String(s ?? "").match(/(\d+(?:\.\d{1,2})?)/); return m ? Number(m[1]) : null; };

/**
 * Build price-per-basis observations from flyer deals. `canon` collapses item-name
 * variants (priceCanon-backed); `resolveBrand` maps a rival NAME to its canonical
 * brand (entity resolution, so branches dedupe); `basisMap` (keyed by canonical item)
 * is the inferred unit basis so an implicit price is read on the RIGHT basis (produce
 * per lb, herbs per bunch, eggs per dozen) and only compared to the same basis.
 */
function buildFlyerObs(
  myDeals: FlyerDeal[], compDeals: FlyerDeal[], targetBrand: string,
  canon: (item: string) => string, resolveBrand: (rivalName: string) => string, basisMap: Record<string, UnitBasis>,
): KviObservation[] {
  const obs: KviObservation[] = [];
  const add = (item: string, priceStr: string | undefined, brand: string) => {
    const it = String(item ?? "").trim(); if (!it || !brand) return;
    const amount = parsePrice(priceStr); if (amount == null || amount <= 0) return;
    const c = canon(it); if (c.length < 3) return;
    // 1) explicit pack/size in the name → true price-per-unit
    const bare = it.match(/\b(lbs?|oz|gallons?|gal|quarts?|qt|pints?|pt|l|ml|dozen|dz|ct|each|ea)\s*$/i);
    const cp = comparablePrice(it, { amount, unit: bare ? `per ${bare[1]}` : undefined });
    if (cp) { obs.push({ brand, canon: c, perBase: cp.perBase, family: cp.family }); return; }
    // 2) no explicit unit → interpret on the item's INFERRED basis; unknown → "listing"
    const bs = basisMap[unitBasisKey(c)];
    obs.push({ brand, canon: c, perBase: amount, family: bs ? bs.family : "listing" });
  };
  for (const d of myDeals ?? []) add(d.item ?? "", d.price, targetBrand);
  for (const d of compDeals ?? []) { const b = resolveBrand(d.rival ?? ""); if (b && b !== targetBrand) add(d.item ?? "", d.price, b); }
  return obs;
}

/** KVI staples where the target is priced ABOVE market (a gap to close). */
export function flyerKviGaps(
  myDeals: FlyerDeal[], compDeals: FlyerDeal[], targetBrand: string,
  canon: (item: string) => string, resolveBrand: (rivalName: string) => string, basisMap: Record<string, UnitBasis>,
  opts: { minOverPct?: number; minRivals?: number } = {},
): KviGap[] {
  return kviPriceGaps(buildFlyerObs(myDeals, compDeals, targetBrand, canon, resolveBrand, basisMap), targetBrand, opts);
}

/** KVI staples where the target is priced BELOW market (a promotable price win). */
export function flyerKviLeads(
  myDeals: FlyerDeal[], compDeals: FlyerDeal[], targetBrand: string,
  canon: (item: string) => string, resolveBrand: (rivalName: string) => string, basisMap: Record<string, UnitBasis>,
  opts: { minUnderPct?: number; minRivals?: number } = {},
): KviLead[] {
  return kviPriceLeads(buildFlyerObs(myDeals, compDeals, targetBrand, canon, resolveBrand, basisMap), targetBrand, opts);
}
