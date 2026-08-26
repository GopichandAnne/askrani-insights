import type { ExtractionResult } from "./contract";
import type { BusinessContext, ValidationIssue, ValidationResult, VerticalModule } from "./vertical";

/**
 * Dental / orthodontic practice module — the 'dental' vertical.
 *
 * Dental does NOT publish a priced menu of dishes, so the money signals that
 * actually decide where a patient goes are different from food or even salon:
 *   • NEW-PATIENT SPECIALS — "$99 exam + cleaning + X-ray", "free whitening for
 *     new patients", "free implant/Invisalign consult" — the real price lever.
 *   • BIG-TICKET service pricing — implants, Invisalign/ortho, veneers, crowns,
 *     whitening — usually "from $X" / financed.
 *   • MEMBERSHIP / in-house savings plans — for the uninsured ("$399/yr, 2 cleanings
 *     + exams + X-rays").
 *   • FINANCING — CareCredit / Cherry / Sunbit "as low as $X/mo".
 *   • INSURANCE accepted — which PPOs/payers ("in-network with Delta Dental, Cigna").
 *   • ACCESS signals — emergency / same-day, evening & weekend hours, sedation,
 *     pediatric — captured as plain service listings so coverage/"what's winning"
 *     has something to compare even when no price is published.
 * We also let zero-price marquee services through as regular_listing so the
 * synthesis pillars can see the service mix, not just the promos.
 */

const INTENTS = [
  "new_patient_special", // first-visit exam/cleaning/X-ray or free-whitening hook
  "service_offer",       // a discounted/promoted procedure (whitening, Invisalign day)
  "membership",          // in-house savings / dental membership plan
  "financing",           // CareCredit / Cherry / Sunbit "as low as $X/mo"
  "insurance",           // which insurances/PPOs are accepted / in-network
  "seasonal_special",    // holiday / back-to-school / event-tied promo
  "event",               // free consult day, open house, community screening
  "price_change",
  "regular_listing",     // a plain service / price listing — not a promotion (hard negative)
  "before_after",        // smile-transformation results showcase
  "editorial",           // patient education / practice news
] as const;

const PROMO = new Set(["sale", "member_price", "combo"]);

export class DentalModule implements VerticalModule {
  readonly vertical = "dental";
  readonly intents = INTENTS;

  buildSystemPrompt(ctx: BusinessContext): string {
    const known = ctx.knownEntities?.length
      ? `Known services/procedures for this practice: ${ctx.knownEntities.slice(0, 120).join(", ")}.`
      : "No prior service list is known for this practice yet.";
    return [
      "You are a dental / orthodontic practice market-intelligence extractor.",
      "Return only JSON matching the provided schema. Extract only facts supported by the supplied evidence (website text, service or fees page, caption text, OCR of a flyer/graphic, image). Preserve original wording in entity_text. Do not invent values; omit unsupported fields. Mark inferred fields with lower confidence.",
      "",
      "Classify content_intent into exactly one of: " + INTENTS.join(", ") + ".",
      "A plain service or fee listing with no promotion is regular_listing; a smile before/after or educational post is before_after/editorial — none of these are promotions.",
      "",
      "Extract, as separate entities:",
      "- NEW-PATIENT SPECIALS: the hook offered to first-time patients (e.g. '$99 new patient exam, cleaning & X-rays', 'Free whitening for new patients', 'Free implant consult'). pricing.type = sale; put 'new patients only' + any 'without insurance' / 'with qualifying treatment' terms in conditions.",
      "- BIG-TICKET PROCEDURES with a price: implants, Invisalign / clear aligners / braces, veneers, crowns, root canals, whitening (Zoom/in-office/take-home), dentures. Capture 'from $X' as pricing.amount; brand when named (Invisalign, ClearCorrect, Zoom, CEREC, iTero).",
      "- MEMBERSHIP / in-house savings plans: recurring or annual price for the uninsured; note what's included + cadence in conditions ('$399/yr — 2 cleanings, 2 exams, X-rays'). pricing.type = member_price.",
      "- FINANCING: a monthly-payment figure ('as low as $99/mo', CareCredit / Cherry / Sunbit); put the monthly amount in pricing.amount and note the provider + 'financed / per month' in conditions. pricing.type = starting_at.",
      "- INSURANCE ACCEPTED: if the practice lists which insurances/PPOs it takes or is in-network with, emit ONE entity with entity_text like 'Insurance accepted' and list the payers (Delta Dental, Cigna, MetLife, Aetna, Guardian, United, in-network/PPO) in conditions. content_intent = insurance. No price.",
      "- MARQUEE / ACCESS SERVICES even with no price: emergency / same-day dentistry, sedation / sleep dentistry, pediatric / kids, cosmetic, orthodontics, implants, extended (evening/weekend) hours. Emit each as entity_text with pricing.type = unknown so the service mix is captured.",
      "",
      "For each entity:",
      "- entity_text: the service/offer exactly as written (e.g. 'Dental Implants', 'Invisalign', 'New Patient Special', 'Emergency Dentistry', 'Zoom Whitening').",
      "- pricing.type: one of regular, sale, starting_at, member_price, combo, unknown.",
      "  * intro / first-time / new-patient specials → sale, with 'new patients only' in conditions.",
      "  * 'from $X' big-ticket or a financed monthly figure → starting_at; note 'starting price' or 'per month, financed' in conditions.",
      "  * a bundle of services at one price → combo.",
      "- conditions: eligibility ('new patients only', 'without insurance'), what's included, consultation/qualifying-treatment requirements, expiry, financing provider, insurance/PPO names.",
      "- validity.start/end: only when a promo window is stated; resolve relative dates against the post date.",
      "- Bind every priced field to evidence (text span, OCR block, or image region).",
      "",
      `Practice: ${ctx.name ?? "unknown"} (timezone ${ctx.timezone ?? "unknown"}).`,
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
        // Dental prices span a wide range: a $99 new-patient special up to a
        // full-arch implant case in the thousands. Flag only clear parse slips.
        if (p.amount < 0 || p.amount > 60000) {
          issues.push(rule(`offers[${i}].pricing.amount`, "price_out_of_range", `implausible price ${p.amount}`, "error"));
          offerAdjustments[i] *= 0.4;
        }
        // A per-month financed figure above ~$1,500 is almost always the full
        // case price mislabeled as a monthly payment — soft flag.
        if (p.type === "starting_at" && /month|\/mo|financ/i.test((offer.conditions ?? []).join(" ")) && p.amount > 1500) {
          issues.push(rule(`offers[${i}].pricing`, "financing_high", `monthly figure ${p.amount} looks like a full-case price`, "warn"));
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
