/**
 * Price unit-normalization + KVI price-gap logic — the algorithmic core of grocery
 * G1 ("you're priced above market on a staple"). Comparing grocery prices fairly
 * requires PRICE-PER-BASE-UNIT: a 10lb rice bag at $18 ($1.80/lb) is cheaper than a
 * 2lb bag at $5 ($2.50/lb) even though $18 > $5. This computes that, per unit family
 * (weight / volume / count), and never compares across families.
 *
 * Pure + fixture-tested. NOTE (2026-09): the flags this powers are gated on data we
 * don't yet have — competitor STAPLE price coverage is near-zero on real grocery
 * workspaces (we have the target's own flyer prices but almost no comparable
 * competitor prices), so wiring this into the detector waits on grocery price-
 * extraction coverage. The logic is built and proven so it lights up the moment
 * coverage exists.
 */

export type UnitFamily = "weight" | "volume" | "count" | "listing"; // "listing" = raw per-listing price (flyer items with no explicit unit — produce specials, per-lb by convention)
export interface PerUnitPrice { perBase: number; family: UnitFamily; baseUnit: "lb" | "floz" | "ct" }

// factor = how many BASE units in one of this unit (base: weight→lb, volume→floz, count→ct)
const WEIGHT: Record<string, number> = { lb: 1, lbs: 1, pound: 1, pounds: 1, "#": 1, oz: 1 / 16, ounce: 1 / 16, ounces: 1 / 16, kg: 2.20462, kgs: 2.20462, g: 0.00220462, gram: 0.00220462, grams: 0.00220462 };
const VOLUME: Record<string, number> = { floz: 1, "fl oz": 1, gallon: 128, gallons: 128, gal: 128, quart: 32, quarts: 32, qt: 32, pint: 16, pints: 16, pt: 16, l: 33.814, liter: 33.814, liters: 33.814, litre: 33.814, ltr: 33.814, ml: 0.033814 };
const COUNT: Record<string, number> = { ct: 1, count: 1, pcs: 1, pc: 1, piece: 1, pieces: 1, pack: 1, packs: 1, pk: 1, ea: 1, each: 1, dozen: 12, dz: 12 };

function familyOf(unit: string): { family: UnitFamily; factor: number; base: PerUnitPrice["baseUnit"] } | null {
  const u = unit.toLowerCase().replace(/\./g, "").trim();
  if (u in WEIGHT) return { family: "weight", factor: WEIGHT[u], base: "lb" };
  if (u in VOLUME) return { family: "volume", factor: VOLUME[u], base: "floz" };
  if (u in COUNT) return { family: "count", factor: COUNT[u], base: "ct" };
  return null;
}

const UNIT_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(lbs?|pounds?|#|oz|ounces?|kgs?|g|grams?|gallons?|gal|quarts?|qt|pints?|pt|l|liters?|litres?|ltr|ml|ct|count|pcs?|pieces?|packs?|pk|dozen|dz)\\b`,
  "i",
);
// "half gallon" / "half-gallon" → qty 0.5 gallon
const HALF_RE = /\bhalf[\s-]?(gallon|gal|pint|pt|dozen|dz|lb|pound)\b/i;

/**
 * Normalize a priced offer to price-per-base-unit. Uses pricing.unit ("per lb")
 * when present (amount is already per that unit), else parses qty+unit from the
 * item name. Returns null when the unit can't be determined — never guesses.
 */
export function comparablePrice(name: string, pricing: { amount?: unknown; unit?: unknown } | null | undefined): PerUnitPrice | null {
  const amount = Number(pricing?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // pricing.unit like "per lb" → amount is already $/unit (implied qty 1)
  const pu = String(pricing?.unit ?? "").toLowerCase().match(/per\s+([a-z ]+)/);
  if (pu) {
    const f = familyOf(pu[1]);
    if (f) return { perBase: amount / f.factor, family: f.family, baseUnit: f.base };
  }

  const n = String(name ?? "");
  const m = n.match(UNIT_RE);
  if (m) {
    const qty = Number(m[1]); const f = familyOf(m[2]);
    if (f && qty > 0) return { perBase: amount / (qty * f.factor), family: f.family, baseUnit: f.base };
  }
  const h = n.match(HALF_RE);
  if (h) { const f = familyOf(h[1]); if (f) return { perBase: amount / (0.5 * f.factor), family: f.family, baseUnit: f.base }; }
  return null;
}

export interface KviObservation { brand: string; canon: string; perBase: number; family: UnitFamily }
export interface KviGap {
  canon: string; family: UnitFamily;
  targetPerBase: number; marketMedian: number; cheapest: { brand: string; perBase: number };
  overPct: number;           // how far the target is above the market median (%)
  rivalsCheaper: string[];   // distinct rival brands cheaper than target
  basis: number;             // distinct brands compared (incl. target)
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * KVI price gaps: for each canonical staple priced by the target AND ≥minRivals
 * rival brands in the SAME unit family, flag when the target is materially above
 * the market median. Precision-first: needs a real comparison basis and a material
 * gap; skips mixed-family items.
 */
export function kviPriceGaps(obs: KviObservation[], targetBrand: string, opts: { minOverPct?: number; minRivals?: number } = {}): KviGap[] {
  const minOverPct = opts.minOverPct ?? 10;
  const minRivals = opts.minRivals ?? 2;
  const byKey = new Map<string, KviObservation[]>();
  for (const o of obs) { const k = `${o.canon}|${o.family}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(o); }

  const gaps: KviGap[] = [];
  for (const rows of byKey.values()) {
    // one price per brand (cheapest listing for that brand), target vs rivals
    const perBrand = new Map<string, number>();
    for (const r of rows) { const cur = perBrand.get(r.brand); if (cur == null || r.perBase < cur) perBrand.set(r.brand, r.perBase); }
    const t = perBrand.get(targetBrand);
    if (t == null) continue;                                   // need the target's own price
    const rivals = [...perBrand.entries()].filter(([b]) => b !== targetBrand);
    if (rivals.length < minRivals) continue;                   // need a real comparison basis
    const rivalPrices = rivals.map(([, p]) => p);
    const mkt = median(rivalPrices);
    const overPct = ((t - mkt) / mkt) * 100;
    if (overPct < minOverPct) continue;                        // only flag a material over-market gap
    const cheapest = rivals.reduce((a, b) => (b[1] < a[1] ? b : a));
    gaps.push({
      canon: rows[0].canon, family: rows[0].family,
      targetPerBase: t, marketMedian: mkt, cheapest: { brand: cheapest[0], perBase: cheapest[1] },
      overPct: Math.round(overPct), rivalsCheaper: rivals.filter(([, p]) => p < t).map(([b]) => b),
      basis: perBrand.size,
    });
  }
  return gaps.sort((a, b) => b.overPct - a.overPct);
}

export interface KviLead {
  canon: string; family: UnitFamily;
  targetPerBase: number; marketMedian: number;
  underPct: number;        // how far BELOW the market median the target is (%)
  beats: string[];         // distinct rival brands the target undercuts
  basis: number;           // distinct brands compared (incl. target)
}

/**
 * KVI price LEADERSHIP — the positive inverse of kviPriceGaps: staples where the
 * target is materially BELOW the market median (a promotable price advantage). Same
 * precision bar: target price + >=2 rival brands in the same item x family.
 */
export function kviPriceLeads(obs: KviObservation[], targetBrand: string, opts: { minUnderPct?: number; minRivals?: number } = {}): KviLead[] {
  const minUnderPct = opts.minUnderPct ?? 10;
  const minRivals = opts.minRivals ?? 2;
  const byKey = new Map<string, KviObservation[]>();
  for (const o of obs) { const k = `${o.canon}|${o.family}`; (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(o); }

  const leads: KviLead[] = [];
  for (const rows of byKey.values()) {
    const perBrand = new Map<string, number>();
    for (const r of rows) { const cur = perBrand.get(r.brand); if (cur == null || r.perBase < cur) perBrand.set(r.brand, r.perBase); }
    const t = perBrand.get(targetBrand);
    if (t == null) continue;
    const rivals = [...perBrand.entries()].filter(([b]) => b !== targetBrand);
    if (rivals.length < minRivals) continue;
    const mkt = median(rivals.map(([, p]) => p));
    const underPct = ((mkt - t) / mkt) * 100;
    if (underPct < minUnderPct) continue;
    leads.push({
      canon: rows[0].canon, family: rows[0].family,
      targetPerBase: t, marketMedian: mkt, underPct: Math.round(underPct),
      beats: rivals.filter(([, p]) => p > t).map(([b]) => b), basis: perBrand.size,
    });
  }
  return leads.sort((a, b) => b.underPct - a.underPct);
}
