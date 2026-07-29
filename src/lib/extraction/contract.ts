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
  // one of: caption span, ocr block, image bbox [x,y,w,h] (0..1), transcript ts
  kind: z.enum(["caption_span", "ocr_block", "image_bbox", "transcript_ts", "dom_element"]),
  media_id: z.string().optional(),
  // free-form locator matching `kind`; validated softly to tolerate model output
  locator: z.record(z.string(), z.any()).default({}),
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
      "unknown",
    ])
    .default("unknown"),
  amount: z.number().nonnegative().optional(),
  currency: z.string().default("USD"),
  unit: z.string().optional(), // per item, per lb, per person…
  original_amount: z.number().nonnegative().optional(), // for sales/price history
});
export type Pricing = z.infer<typeof Pricing>;

export const ExtractedOffer = z.object({
  entity_text: z.string(), // original wording, preserved (guide 8.2)
  canonical_entity_id: z.string().nullable().optional(),
  // restaurant-relevant descriptors; grocery reuses brand/size_* (guide 7.2/7.3)
  brand: z.string().optional(),
  cuisine: z.string().optional(),
  meal_period: z.enum(["breakfast", "brunch", "lunch", "dinner", "late_night", "all_day"]).optional(),
  dietary_tags: z.array(z.string()).default([]),
  size_value: z.number().optional(),
  size_unit: z.string().optional(),
  pricing: Pricing.default({ type: "unknown", currency: "USD" }),
  conditions: z.array(z.string()).default([]),
  evidence: z.array(EvidenceRef).default([]),
  confidence: z.number().min(0).max(1),
});
export type ExtractedOffer = z.infer<typeof ExtractedOffer>;

export const ExtractionResult = z.object({
  content_intent: z.object({
    value: z.string(), // e.g. new_dish, lunch_special, weekly_sale, editorial…
    confidence: z.number().min(0).max(1),
  }),
  business_vertical: z.string(),
  validity: z
    .object({
      start: z.string().nullable().optional(), // ISO date
      end: z.string().nullable().optional(),
      confidence: z.number().min(0).max(1).default(0),
    })
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
