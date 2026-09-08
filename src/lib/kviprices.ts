import { comparablePrice, kviPriceGaps, type KviObservation, type KviGap } from "@/lib/priceunits";

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

// price-per-unit if a size parses, else a raw per-listing price
function priced(item: string, priceStr?: string): { perBase: number; family: KviObservation["family"] } | null {
  const amount = parsePrice(priceStr);
  if (amount == null || amount <= 0) return null;
  const bare = item.match(/\b(lbs?|oz|gallons?|gal|quarts?|qt|pints?|pt|l|ml|dozen|dz|ct|each|ea)\s*$/i);
  const cp = comparablePrice(item, { amount, unit: bare ? `per ${bare[1]}` : undefined });
  if (cp) return { perBase: cp.perBase, family: cp.family };
  return { perBase: amount, family: "listing" };
}

/**
 * Compute KVI price gaps from flyer deals. `canon` collapses item-name variants to
 * a shared label (pass the workspace's priceCanon-backed normalizer); `resolveBrand`
 * maps a rival NAME to its canonical brand (entity resolution, so branches dedupe).
 */
export function flyerKviGaps(
  myDeals: FlyerDeal[],
  compDeals: FlyerDeal[],
  targetBrand: string,
  canon: (item: string) => string,
  resolveBrand: (rivalName: string) => string,
  opts: { minOverPct?: number; minRivals?: number } = {},
): KviGap[] {
  const obs: KviObservation[] = [];
  const add = (item: string, priceStr: string | undefined, brand: string) => {
    const it = String(item ?? "").trim(); if (!it || !brand) return;
    const p = priced(it, priceStr); if (!p) return;
    const c = canon(it); if (c.length < 3) return;
    obs.push({ brand, canon: c, perBase: p.perBase, family: p.family });
  };
  for (const d of myDeals ?? []) add(d.item ?? "", d.price, targetBrand);
  for (const d of compDeals ?? []) { const b = resolveBrand(d.rival ?? ""); if (b && b !== targetBrand) add(d.item ?? "", d.price, b); }
  return kviPriceGaps(obs, targetBrand, opts);
}
