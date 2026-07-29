import type { ExtractionResult } from "./contract";
import type { BusinessContext, ValidationIssue, ValidationResult, VerticalModule } from "./vertical";

/**
 * Restaurant vertical module — guide 7.3.
 * Entities: dish, cuisine, meal period, portion, components, add-ons, dietary
 * tags, dine-in/takeout/delivery. Pricing: item, combo, buffet, prix fixe,
 * starting-at, happy hour, catering, delivery minimum, discount. Campaign types
 * are the intent taxonomy below.
 */

const INTENTS = [
  "new_dish",
  "limited_time_menu",
  "lunch_special",
  "happy_hour",
  "buffet",
  "event_night",
  "influencer_visit",
  "catering",
  "reservation",
  "loyalty_offer",
  "price_change",
  "hours_change",
  "regular_menu", // hard negative: not a promotion (guide 15.1)
  "editorial", // testimonials / brand content — not an offer
] as const;

export class RestaurantModule implements VerticalModule {
  readonly vertical = "restaurant";
  readonly intents = INTENTS;

  buildSystemPrompt(ctx: BusinessContext): string {
    const known = ctx.knownEntities?.length
      ? `Known menu items and aliases for this business: ${ctx.knownEntities.slice(0, 120).join(", ")}.`
      : "No prior menu is known for this business yet.";
    return [
      "You are a restaurant market-intelligence extractor.",
      "Return only JSON matching the provided schema. Extract only facts supported by the supplied evidence (caption text, OCR, image, menu). Preserve original wording in entity_text. Do not invent missing values; omit unsupported fields. Mark inferred fields with lower confidence.",
      "",
      "Classify content_intent into exactly one of: " + INTENTS.join(", ") + ".",
      "Treat a plain standing menu, a testimonial, or generic brand content as regular_menu or editorial — these are NOT promotions.",
      "",
      "For each distinct dish/offer:",
      "- entity_text: the dish/offer exactly as written.",
      "- meal_period: breakfast|brunch|lunch|dinner|late_night|all_day when discernible.",
      "- pricing.type: one of regular, sale, combo, buffet, prix_fixe, starting_at, happy_hour, multi_buy, bogo, catering, unknown.",
      "- Distinguish a starting-at price from a fixed price (guide 7.4 caveat).",
      "- dietary_tags: e.g. vegetarian, vegan, halal, gluten_free — only if stated.",
      "- conditions: dine-in only, delivery minimum, time windows, per-person, etc.",
      "- validity.start/end: only when the post states a date/'this week'/'through Sunday'; resolve relative dates against the post publication date.",
      "- Bind every priced field to evidence (caption span, OCR block, or image bbox).",
      "",
      `Business: ${ctx.name ?? "unknown"} (timezone ${ctx.timezone ?? "unknown"}).`,
      known,
      ctx.postPublishedAt ? `Post published at: ${ctx.postPublishedAt}.` : "",
      "Report contradictions or ambiguity in warnings[].",
    ]
      .filter(Boolean)
      .join("\n");
  }

  validate(result: ExtractionResult, ctx: BusinessContext): ValidationResult {
    const issues: ValidationIssue[] = [];
    // Per-offer multiplier so one bad offer doesn't penalize its siblings.
    const offerAdjustments = result.offers.map(() => 1);

    for (const [i, offer] of result.offers.entries()) {
      const p = offer.pricing;
      if (p.amount != null) {
        // Range validation (guide 6.4). $0 is legitimate (free/loyalty item);
        // only negative or absurdly high prices are implausible.
        if (p.amount < 0 || p.amount > 1000) {
          issues.push(rule(`offers[${i}].pricing.amount`, "price_out_of_range", `implausible price ${p.amount}`, "error"));
          offerAdjustments[i] *= 0.4;
        }
        // A "sale" must have an original price higher than the sale price.
        if (p.type === "sale" && p.original_amount != null && p.original_amount <= p.amount) {
          issues.push(rule(`offers[${i}].pricing`, "sale_not_cheaper", "sale price not below original", "warn"));
          offerAdjustments[i] *= 0.7;
        }
      }
      // Priced offers should carry evidence (Appendix D: no observation w/o evidence).
      if (p.amount != null && offer.evidence.length === 0) {
        issues.push(rule(`offers[${i}].evidence`, "missing_evidence", "priced offer has no evidence binding", "warn"));
        offerAdjustments[i] *= 0.9;
      }
    }

    // ── result-level checks apply to every offer ──────────────────────────
    let adj = 1;
    const { start, end } = result.validity ?? {};
    if (start && end && new Date(end) < new Date(start)) {
      issues.push(rule("validity", "end_before_start", "validity end precedes start", "error"));
      adj *= 0.5;
    }
    if ((result.content_intent.value === "editorial" || result.content_intent.value === "regular_menu") &&
        result.offers.some((o) => o.pricing.type !== "regular" && o.pricing.type !== "unknown")) {
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
