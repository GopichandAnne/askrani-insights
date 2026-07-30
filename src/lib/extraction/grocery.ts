import type { ExtractionResult } from "./contract";
import type { BusinessContext, ValidationIssue, ValidationResult, VerticalModule } from "./vertical";

/**
 * Grocery vertical module — guide §7.2.
 * Entities: brand, product, variant, size, unit, produce type, meat cut,
 * category. Pricing: unit price, per-pound, each, multi-buy, buy/get, threshold
 * gift, member price, limit, coupon requirement. Campaign types = the intents.
 */

const INTENTS = [
  "weekly_sale",
  "festival_sale",
  "sampling",
  "spend_and_get",
  "clearance",
  "availability",
  "loss_leader",
  "multi_buy",
  "coupon",
  "member_price",
  "new_product",
  "price_change",
  "regular_listing", // a plain shelf listing — not a promotion (hard negative)
  "editorial",
] as const;

const PROMO = new Set(["sale", "multi_buy", "bogo", "member_price", "clearance"]);

export class GroceryModule implements VerticalModule {
  readonly vertical = "grocery";
  readonly intents = INTENTS;

  buildSystemPrompt(ctx: BusinessContext): string {
    const known = ctx.knownEntities?.length
      ? `Known products/brands for this store: ${ctx.knownEntities.slice(0, 120).join(", ")}.`
      : "No prior catalog is known for this store yet.";
    return [
      "You are a grocery/supermarket market-intelligence extractor.",
      "Return only JSON matching the provided schema. Extract only facts supported by the supplied evidence (caption text, OCR of a flyer, product image, page). Preserve original wording in entity_text. Do not invent values; omit unsupported fields. Mark inferred fields with lower confidence.",
      "",
      "Classify content_intent into exactly one of: " + INTENTS.join(", ") + ".",
      "A plain shelf/price listing with no promotion is regular_listing; brand/lifestyle content is editorial — neither is a promotion.",
      "",
      "For each distinct product/offer:",
      "- entity_text: the product exactly as written (include brand + variant).",
      "- brand: the brand if stated (e.g. Aashirvaad, Nestlé).",
      "- size_value + size_unit: pack/quantity when shown (e.g. 20 lb, 500 g, 12 ct).",
      "- pricing.type: one of regular, sale, multi_buy, bogo, member_price, clearance, unknown.",
      "  * multi_buy → put the deal in conditions (e.g. '2 for $5'); amount = per-unit price if derivable.",
      "  * member_price → price requires a loyalty/club card (note in conditions).",
      "  * pricing.unit → 'per lb', 'each', 'per oz' when the price is a unit price.",
      "- conditions: limits ('limit 4'), coupon required, card required, min-spend, dates.",
      "- validity.start/end: only when the flyer/post states a sale window; resolve relative dates against the post date.",
      "- Bind every priced field to evidence (caption span, OCR block, or image region).",
      "",
      `Store: ${ctx.name ?? "unknown"} (timezone ${ctx.timezone ?? "unknown"}).`,
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
        // grocery price plausibility ($0 = free/loyalty is allowed; bulk cases
        // can be pricey, so cap higher than restaurant)
        if (p.amount < 0 || p.amount > 2000) {
          issues.push(rule(`offers[${i}].pricing.amount`, "price_out_of_range", `implausible price ${p.amount}`, "error"));
          offerAdjustments[i] *= 0.4;
        }
        if (p.type === "sale" && p.original_amount != null && p.original_amount <= p.amount) {
          issues.push(rule(`offers[${i}].pricing`, "sale_not_cheaper", "sale price not below original", "warn"));
          offerAdjustments[i] *= 0.7;
        }
        // a per-lb/per-oz unit price that's implausibly high suggests a parse slip
        if (/lb|oz|kg|g\b/i.test(p.unit ?? "") && p.amount > 100) {
          issues.push(rule(`offers[${i}].pricing.unit`, "unit_price_high", `unit price ${p.amount} ${p.unit} looks off`, "warn"));
          offerAdjustments[i] *= 0.8;
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
    if ((result.content_intent.value === "editorial" || result.content_intent.value === "regular_listing") &&
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
