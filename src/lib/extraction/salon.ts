import type { ExtractionResult } from "./contract";
import type { BusinessContext, ValidationIssue, ValidationResult, VerticalModule } from "./vertical";

/**
 * Beauty / med-spa vertical module — the 'salon' vertical (guide §7.4 expansion).
 * Covers med spas, aesthetics clinics, day spas, salons, barbers, nail/lash/brow.
 *
 * Entities: treatment/service, service area (face/body), package, membership,
 * add-on. Pricing here is unlike food — the money signals that actually matter
 * to an owner are: per-unit pricing (Botox "$12/unit"), per-session vs package
 * (e.g. "6 sessions"), first-time/intro specials, memberships, and financing
 * ("as low as $99/mo"). Campaign types = the intents.
 */

const INTENTS = [
  "new_treatment",
  "intro_offer",       // first-time / new-client special
  "seasonal_special",  // event- or holiday-tied promo (e.g. "Botox day")
  "package_deal",      // bundle of sessions / treatments at a set price
  "membership",        // monthly membership / loyalty program
  "financing",         // Cherry/Afterpay-style "as low as $X/mo"
  "giveaway",          // contest / free treatment draw
  "event",             // open house, pop-up, injectable day
  "price_change",
  "regular_listing",   // a plain service/price listing — not a promotion (hard negative)
  "before_after",      // results showcase (editorial-ish, not a promo)
  "editorial",
] as const;

const PROMO = new Set(["sale", "package", "membership", "financing", "intro"]);

export class SalonModule implements VerticalModule {
  readonly vertical = "salon";
  readonly intents = INTENTS;

  buildSystemPrompt(ctx: BusinessContext): string {
    const known = ctx.knownEntities?.length
      ? `Known treatments/services for this business: ${ctx.knownEntities.slice(0, 120).join(", ")}.`
      : "No prior service menu is known for this business yet.";
    return [
      "You are a beauty / med-spa / aesthetics market-intelligence extractor.",
      "Return only JSON matching the provided schema. Extract only facts supported by the supplied evidence (caption text, OCR of a flyer, service-menu page, image). Preserve original wording in entity_text. Do not invent values; omit unsupported fields. Mark inferred fields with lower confidence.",
      "",
      "Classify content_intent into exactly one of: " + INTENTS.join(", ") + ".",
      "A plain service/price listing with no promotion is regular_listing; a before/after or educational post is before_after/editorial — none of these are promotions.",
      "",
      "For each distinct treatment/service/offer:",
      "- entity_text: the treatment exactly as written (e.g. 'Botox', 'HydraFacial', 'Full-face filler', 'Laser hair removal — full legs').",
      "- brand: the product/brand if named (e.g. Botox, Dysport, Juvéderm, SkinPen, CoolSculpting, Morpheus8).",
      "- pricing.type: one of regular, sale, package, membership, financing, unknown.",
      "  * pricing.unit → 'per unit' (injectables), 'per session', 'per area', 'per syringe', 'each' when applicable.",
      "  * package → a fixed price for multiple sessions/treatments; put the count/contents in conditions (e.g. '6 sessions').",
      "  * membership → recurring price; note cadence in conditions (e.g. '$99/month, includes 1 facial').",
      "  * financing → a monthly-payment figure ('as low as $99/mo'); capture the monthly amount in pricing.amount and note it's financed in conditions.",
      "  * intro / first-time specials → pricing.type sale, and note 'new clients only' in conditions.",
      "- conditions: eligibility ('new clients only'), minimums, consultation required, expiry, per-unit vs per-area basis, financing terms.",
      "- validity.start/end: only when a promo window is stated; resolve relative dates against the post date.",
      "- Bind every priced field to evidence (caption span, OCR block, or image region).",
      "",
      `Business: ${ctx.name ?? "unknown"} (timezone ${ctx.timezone ?? "unknown"}).`,
      known,
      ctx.postPublishedAt ? `Post published at: ${ctx.postPublishedAt}.` : "",
      "Report contradictions or ambiguity in warnings[].",
    ]
      .filter(Boolean)
      .join("\n");
  }

  validate(result: ExtractionResult, _ctx: BusinessContext): ValidationResult {
    const issues: ValidationIssue[] = [];
    const offerAdjustments = result.offers.map(() => 1);

    for (const [i, offer] of result.offers.entries()) {
      const p = offer.pricing;
      if (p.amount != null) {
        // Aesthetic pricing spans a wide range: a $12 Botox unit up to a
        // multi-thousand-dollar body/laser package. Flag only clear parse slips.
        if (p.amount < 0 || p.amount > 50000) {
          issues.push(rule(`offers[${i}].pricing.amount`, "price_out_of_range", `implausible price ${p.amount}`, "error"));
          offerAdjustments[i] *= 0.4;
        }
        // A "per unit" price above ~$100 is almost always a per-syringe/area
        // figure mislabeled as per-unit — worth a soft flag.
        if (/per\s*unit/i.test(p.unit ?? "") && p.amount > 100) {
          issues.push(rule(`offers[${i}].pricing.unit`, "unit_price_high", `per-unit price ${p.amount} looks like a per-area/syringe figure`, "warn"));
          offerAdjustments[i] *= 0.8;
        }
        if (p.type === "sale" && p.original_amount != null && p.original_amount <= p.amount) {
          issues.push(rule(`offers[${i}].pricing`, "sale_not_cheaper", "sale price not below original", "warn"));
          offerAdjustments[i] *= 0.7;
        }
      }
      if (p.amount != null && offer.evidence.length === 0) {
        issues.push(rule(`offers[${i}].evidence`, "missing_evidence", "priced offer has no evidence", "warn"));
        offerAdjustments[i] *= 0.9;
      }
    }

    let adj = 1;
    const { start, end } = result.validity ?? {};
    if (start && end && new Date(end) < new Date(start)) {
      issues.push(rule("validity", "end_before_start", "validity end precedes start", "error"));
      adj *= 0.5;
    }
    if ((result.content_intent.value === "editorial" || result.content_intent.value === "regular_listing" || result.content_intent.value === "before_after") &&
        result.offers.some((o) => PROMO.has(o.pricing.type))) {
      issues.push(rule("content_intent", "intent_offer_mismatch", "promotional pricing under non-promo intent", "warn"));
      adj *= 0.9;
    }

    return {
      ok: !issues.some((x) => x.severity === "error"),
      issues,
      confidenceAdjustment: adj,
      offerAdjustments,
    };
  }
}

function rule(field: string, code: string, message: string, severity: "warn" | "error"): ValidationIssue {
  return { field, code, message, severity };
}
