/**
 * Supply-saturation / adoption-curve estimator — where a concept sits on the local
 * adoption curve, which flips the recommendation between "prime early opening" and
 * "you're already late / table stakes". Deliberately NOT a fitted S-curve (that's
 * unidentifiable at our N and history) — an ordinal state on the adoption fraction,
 * with a VISIBILITY gate that is the whole point:
 *
 * Our competitor coverage is incomplete, so the adopter count is biased LOW — and
 * "low saturation" is exactly the reading that says "go, you're early" (the costly
 * direction to be wrong in). So a low-saturation state is only trusted as an opening
 * when we've actually SEEN enough competitor menus to believe the "few rivals" count;
 * otherwise it collapses to "unknown" and must NOT be sold as an opportunity.
 *
 * Everything here is brand-level (branches deduped upstream by entity resolution).
 */

export type CurveState =
  | "absent"      // no observed adopter
  | "early"       // few adopters, gap open — the opening (only when visible)
  | "contested"   // several adopters, gap still open
  | "saturated"   // most adopters — table stakes
  | "unknown";    // too little coverage to trust a low-saturation read

export interface SaturationRead {
  adopters: number;       // competitor BRANDS observed doing it
  total: number;          // competitor brands in the set
  coveredN: number;       // brands whose standing offerings (menu) we actually have
  coverageFrac: number;   // coveredN / total
  saturation: number;     // adopters / total (point; biased low by unobserved brands)
  state: CurveState;
  visible: boolean;       // enough menu coverage to trust a "few rivals" (low-sat) read
}

// thresholds (hand-set; tunable once owner labels accrue)
const SAT_SATURATED = 0.6;   // ≥60% of brands → table stakes
const SAT_CONTESTED = 0.3;   // 30–60% → crowded but gap open
const MIN_COVERED = 3;       // need at least this many competitor menus…
const MIN_COVERAGE = 0.4;    // …and this fraction of the set, to trust a low-sat read

export function readSaturation(adopters: number, total: number, coveredN: number): SaturationRead {
  const t = Math.max(1, total);
  const coverageFrac = coveredN / t;
  const saturation = adopters / t;
  const visible = coveredN >= MIN_COVERED && coverageFrac >= MIN_COVERAGE;

  let state: CurveState;
  if (saturation >= SAT_SATURATED) state = "saturated";
  else if (saturation >= SAT_CONTESTED) state = "contested";
  else if (adopters > 0) state = "early";
  else state = "absent";

  // A low-saturation read (early / absent) is trustworthy as an OPENING only if we
  // have the visibility to believe the small count; otherwise "few rivals" may just
  // be "we didn't see their menus" → unknown, never surfaced as an opportunity.
  if ((state === "early" || state === "absent") && !visible) state = "unknown";

  return { adopters, total: t, coveredN, coverageFrac, saturation, state, visible };
}
