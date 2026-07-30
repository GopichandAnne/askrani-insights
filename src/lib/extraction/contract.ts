import { z } from "zod";

/**
 * Multimodal extraction contract — guide 6.3. This zod schema is the JSON the
 * model must return, and it is validated at the tool-call boundary so malformed
 * or hallucinated shapes are rejected before they touch the data model.
 *
 * Every field that carries a claim also carries evidence + confidence — the
 * platform's core promise (guide Success definition: "Every observation exposes
 * source, observed time, confidence, evidence").
 */

export const EvidenceRef = z.object({
  // one of: caption span, ocr block, image bbox [x,y,w,h] (0..1), transcript ts.
  // Tolerant: an unrecognized kind from the model degrades to caption_span
  // instead of discarding the whole extraction.
  kind: z
    .enum(["caption_span", "ocr_block", "image_bbox", "transcript_ts", "dom_element"])
    .catch("caption_span"),
  media_id: z.string().optional(),
  // free-form locator matching `kind`; validated softly to tolerate model output
  locator: z.record(z.string(), z.any()).catch({}).default({}),
  text: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Pricing = z.object({
  type: z
    .enum([
      "regular",
      "sale",
      "combo",
      "buffet",
      "prix_fixe",
      "starting_at",
      "happy_hour",
      "multi_buy",
      "bogo",
      "catering",
      "member_price",
      "clearance",
      "unknown",
    ])
    .catch("unknown")
    .default("unknown"),
  amount: z.number().nonnegative().optional(),
  currency: z.string().default("USD"),
  unit: z.string().optional(), // per item, per lb, per person…
  original_amount: z.number().nonnegative().optional(), // for sales/price history
});
export type Pricing = z.infer<typeof Pricing>;

export const ExtractedOffer = z.object({
  entity_text: z.string().catch(""), // original wording; blanks filtered downstream
  canonical_entity_id: z.string().nullable().optional(),
  // restaurant-relevant descriptors; grocery reuses brand/size_* (guide 7.2/7.3)
  brand: z.string().optional(),
  cuisine: z.string().optional(),
  meal_period: z
    .enum(["breakfast", "brunch", "lunch", "dinner", "late_night", "all_day"])
    .optional()
    .catch(undefined),
  dietary_tags: z.array(z.string()).catch([]).default([]),
  size_value: z.number().optional(),
  size_unit: z.string().optional(),
  pricing: Pricing.default({ type: "unknown", currency: "USD" }),
  conditions: z.array(z.string()).catch([]).default([]),
  evidence: z.array(EvidenceRef).catch([]).default([]),
  // confidence is clamped to [0,1] downstream; tolerate odd values (e.g. 95)
  // rather than fail the whole offer.
  confidence: z.number().catch(0.5),
});
export type ExtractedOffer = z.infer<typeof ExtractedOffer>;

export const ExtractionResult = z.object({
  content_intent: z
    .object({
      value: z.string(), // e.g. new_dish, lunch_special, weekly_sale, editorial…
      confidence: z.number().catch(0),
    })
    .catch({ value: "unknown", confidence: 0 }),
  business_vertical: z.string().catch("restaurant"),
  validity: z
    .object({
      start: z.string().nullable().optional(), // ISO date
      end: z.string().nullable().optional(),
      confidence: z.number().catch(0).default(0),
    })
    .catch({ confidence: 0 })
    .default({ confidence: 0 }),
  offers: z.array(ExtractedOffer).default([]),
  // model must report contradictions/ambiguity it noticed (guide Appendix C)
  warnings: z.array(z.string()).default([]),
  model_version: z.string().default("unknown"),
  schema_version: z.literal("1.0").default("1.0"),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/** JSON Schema handed to the model as a tool definition. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  required: ["content_intent", "business_vertical", "offers"],
  properties: {
    content_intent: {
      type: "object",
      required: ["value", "confidence"],
      properties: {
        value: { type: "string" },
        confidence: { type: "number" },
      },
    },
    business_vertical: { type: "string" },
    validity: {
      type: "object",
      properties: {
        start: { type: ["string", "null"] },
        end: { type: ["string", "null"] },
        confidence: { type: "number" },
      },
    },
    offers: {
      type: "array",
      items: {
        type: "object",
        required: ["entity_text", "confidence"],
        properties: {
          entity_text: { type: "string" },
          canonical_entity_id: { type: ["string", "null"] },
          brand: { type: "string" },
          cuisine: { type: "string" },
          meal_period: { type: "string" },
          dietary_tags: { type: "array", items: { type: "string" } },
          size_value: { type: "number" },
          size_unit: { type: "string" },
          pricing: {
            type: "object",
            properties: {
              type: { type: "string" },
              amount: { type: "number" },
              currency: { type: "string" },
              unit: { type: "string" },
              original_amount: { type: "number" },
            },
          },
          conditions: { type: "array", items: { type: "string" } },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string" },
                media_id: { type: "string" },
                locator: { type: "object" },
                text: { type: "string" },
              },
            },
          },
          confidence: { type: "number" },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    model_version: { type: "string" },
    schema_version: { type: "string" },
  },
} as const;
