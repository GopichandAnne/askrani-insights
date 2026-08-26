import type { PriceHintsReport } from "@/lib/pricehints";

/**
 * Dental procedure BENCHMARK — a ballpark price per procedure for an area, so a
 * practice's pricing can be estimated WITHOUT the owner importing a fee schedule
 * (and the same estimate applies to competitors). Dental works for this because it
 * runs on a standardized code set (CDT): D2740 is always a porcelain crown, so a
 * geographic benchmark is meaningful (unlike fuzzy restaurant menus).
 *
 * Two layers, combined honestly:
 *   1. a national self-pay average RANGE per common procedure (the table below),
 *      scaled by a regional cost multiplier from the practice's state → an "area
 *      typical" range;
 *   2. any REAL local signal we've already scraped (goals.priceHints — prices from
 *      reviews & posts across the local market) overlaid on the matching procedure,
 *      because a real local number beats a generic benchmark.
 *
 * The numbers are APPROXIMATE US self-pay averages compiled from public cost guides
 * (ADA fee survey / FAIR Health-style ranges) — deliberately shown as ranges, never
 * a false-precise fee. They live in ONE table so a licensed dataset (FAIR Health,
 * ADA) or a per-ZIP savings-plan scrape can replace them wholesale later.
 */

export interface BenchProc {
  key: string;          // canonical short label (matches pricehints item labels)
  label: string;        // display name
  cdt?: string;         // CDT code (informational)
  low: number; high: number;  // approximate US self-pay range, USD
  aliases: string[];    // for matching scraped hint labels onto this procedure
}

// Approximate US self-pay averages — validate/replace with a licensed fee dataset.
const PROCS: BenchProc[] = [
  { key: "exam", label: "New-patient exam", cdt: "D0150", low: 75, high: 200, aliases: ["exam", "checkup", "check up", "consultation", "office visit"] },
  { key: "cleaning", label: "Routine cleaning", cdt: "D1110", low: 75, high: 200, aliases: ["cleaning", "teeth cleaning", "prophylaxis", "prophy"] },
  { key: "deep_cleaning", label: "Deep cleaning (per quadrant)", cdt: "D4341", low: 150, high: 400, aliases: ["deep cleaning", "scaling", "root planing", "srp"] },
  { key: "xrays", label: "X-rays (full set)", cdt: "D0210", low: 100, high: 250, aliases: ["x-ray", "xray", "x rays", "radiograph", "panoramic"] },
  { key: "filling", label: "Filling (composite)", cdt: "D2392", low: 150, high: 400, aliases: ["filling", "composite", "cavity"] },
  { key: "crown", label: "Crown (porcelain)", cdt: "D2740", low: 1000, high: 1800, aliases: ["crown", "cap", "porcelain crown"] },
  { key: "root_canal", label: "Root canal (molar)", cdt: "D3330", low: 700, high: 1700, aliases: ["root canal", "endodontic", "rct"] },
  { key: "extraction", label: "Tooth extraction (simple)", cdt: "D7140", low: 100, high: 300, aliases: ["extraction", "tooth removal", "pulled", "pull a tooth"] },
  { key: "wisdom", label: "Wisdom tooth removal (impacted)", cdt: "D7240", low: 300, high: 800, aliases: ["wisdom tooth", "wisdom teeth", "impacted"] },
  { key: "implant", label: "Dental implant (single, w/ crown)", cdt: "D6010", low: 3000, high: 5000, aliases: ["implant", "dental implant", "tooth implant"] },
  { key: "denture", label: "Denture (per arch)", cdt: "D5110", low: 1000, high: 3000, aliases: ["denture", "dentures", "full denture"] },
  { key: "bridge", label: "Bridge (3-unit)", cdt: "D6240", low: 2000, high: 5000, aliases: ["bridge", "dental bridge"] },
  { key: "veneer", label: "Veneer (porcelain, per tooth)", cdt: "D2962", low: 900, high: 2500, aliases: ["veneer", "veneers"] },
  { key: "whitening", label: "Teeth whitening (in-office)", cdt: "D9972", low: 300, high: 800, aliases: ["whitening", "zoom", "bleaching", "teeth whitening"] },
  { key: "invisalign", label: "Invisalign / clear aligners", cdt: "D8090", low: 3000, high: 6000, aliases: ["invisalign", "clear aligners", "aligners"] },
  { key: "braces", label: "Braces (comprehensive)", cdt: "D8080", low: 3000, high: 7000, aliases: ["braces", "orthodontics", "ortho"] },
  { key: "night_guard", label: "Night guard", cdt: "D9944", low: 300, high: 700, aliases: ["night guard", "nightguard", "mouth guard", "occlusal guard"] },
];

// Regional cost-of-care multipliers by US state (approximate, from published
// cost-of-care indices). Default 1.0 for anything not listed.
const STATE_MULT: Record<string, number> = {
  CA: 1.3, NY: 1.35, NJ: 1.25, MA: 1.3, CT: 1.25, WA: 1.2, AK: 1.35, HI: 1.4, MD: 1.2, DC: 1.35, OR: 1.15,
  CO: 1.1, IL: 1.1, VA: 1.1, NH: 1.1, RI: 1.15, VT: 1.1, MN: 1.1, FL: 1.05, AZ: 1.05, NV: 1.05, PA: 1.0, GA: 1.0, NC: 1.0, MI: 1.0, WI: 1.0, TX: 1.0, UT: 1.0,
  OH: 0.95, IN: 0.95, MO: 0.95, SC: 0.95, TN: 0.9, KY: 0.9, LA: 0.9, NM: 0.9, IA: 0.95, KS: 0.9, OK: 0.9, AL: 0.88, AR: 0.85, MS: 0.85, WV: 0.88, NE: 0.92, ID: 0.95, MT: 0.95, ND: 0.95, SD: 0.92,
};

const STATE_NAME: Record<string, string> = {
  california: "CA", "new york": "NY", texas: "TX", florida: "FL", washington: "WA", massachusetts: "MA", colorado: "CO", illinois: "IL", virginia: "VA", arizona: "AZ", georgia: "GA", oregon: "OR", nevada: "NV", michigan: "MI", "north carolina": "NC", pennsylvania: "PA", ohio: "OH", tennessee: "TN", "new jersey": "NJ", maryland: "MD", minnesota: "MN", wisconsin: "WI",
};

/** Pull a 2-letter state code from a US address string (", TX 78613" or "Texas"). */
export function stateFromAddress(address?: string): string | undefined {
  const a = String(address ?? "");
  const m = a.match(/,\s*([A-Z]{2})\s*\d{5}/) ?? a.match(/\b([A-Z]{2})\s+\d{5}\b/);
  if (m && STATE_MULT[m[1]] !== undefined) return m[1];
  if (m) return m[1]; // valid-looking code even if multiplier is default
  const lower = a.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAME)) if (lower.includes(name)) return code;
  return undefined;
}

export interface BallparkRow {
  key: string; label: string; cdt?: string;
  areaLow: number; areaHigh: number;      // benchmark × regional multiplier
  localLow?: number; localHigh?: number;   // real scraped local signal, if any
  localMentions?: number; localWhere?: string;
}
export interface DentalBenchmark {
  region: string;           // e.g. "TX" or "your area"
  multiplier: number;
  rows: BallparkRow[];
  note: string;
}

const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const stepFor = (n: number) => (n >= 1000 ? 50 : n >= 200 ? 25 : 5);

/** Build the ballpark table for a workspace's region, overlaying any local price
 *  hints we've already mined. Deterministic — no DB, no LLM. */
export function buildDentalBenchmark(address: string | undefined, priceHints?: PriceHintsReport | null): DentalBenchmark {
  const state = stateFromAddress(address);
  const mult: number = (state ? STATE_MULT[state] : undefined) ?? 1.0;
  const region = state ?? "your area";

  // index local hints by procedure key (match hint item text against aliases)
  const local = new Map<string, { low: number; high: number; mentions: number; where?: string }>();
  for (const b of priceHints?.byItem ?? []) {
    const item = b.item.toLowerCase();
    const proc = PROCS.find((p) => p.aliases.some((a) => item === a || item.includes(a) || a.includes(item)));
    if (proc) {
      const ex = (priceHints?.hints ?? []).find((h) => !h.isYou && proc.aliases.some((a) => h.item.toLowerCase().includes(a)));
      local.set(proc.key, { low: b.low, high: b.high, mentions: b.mentions, where: ex?.business });
    }
  }

  const rows: BallparkRow[] = PROCS.map((p) => {
    const areaLow = roundTo(p.low * mult, stepFor(p.low * mult));
    const areaHigh = roundTo(p.high * mult, stepFor(p.high * mult));
    const l = local.get(p.key);
    return { key: p.key, label: p.label, cdt: p.cdt, areaLow, areaHigh, localLow: l?.low, localHigh: l?.high, localMentions: l?.mentions, localWhere: l?.where };
  });

  const note = state
    ? `Approximate self-pay ranges for ${state}, scaled from US averages (${mult.toFixed(2)}× regional). Ranges, not exact fees — real prices vary by tooth, materials, insurance and case complexity.`
    : `Approximate US self-pay averages. Add the practice's address to tune to your region. Ranges, not exact fees — prices vary by case and insurance.`;

  return { region, multiplier: mult, rows, note };
}
