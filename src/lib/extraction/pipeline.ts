import type { RawObservation } from "../providers/types";
import { ExtractionResult, EXTRACTION_JSON_SCHEMA } from "./contract";
import { getLlm, isLlmConfigured } from "./llm";
import { moduleFor } from "./modules";
import type { BusinessContext } from "./vertical";

/**
 * Multimodal content intelligence pipeline — guide 6.1.
 *
 *   raw content → (structured-markup shortcut) → model extraction →
 *   deterministic validation → confidence calibration → review routing
 *
 * Tiered processing (guide 16.3): if the source already carries structured
 * JSON-LD offers/menu, we trust those directly and only call the model for the
 * unstructured remainder — the cheapest stage that answers the question.
 */

export type ReviewStatus = "confirmed" | "pending";

export interface PipelineOffer {
  entity_text: string;
  canonical_entity_id: string | null;
  offer_type: string;
  pricing: Record<string, unknown>;
  conditions: string[];
  validity_start: string | null;
  validity_end: string | null;
  confidence: number;
  provenance: RawObservation["provenance"];
  evidence: ExtractionResult["offers"][number]["evidence"];
}

export interface PipelineOutput {
  intent: string;
  intentConfidence: number;
  vertical: string;
  offers: PipelineOffer[];
  warnings: string[];
  review: ReviewStatus;
  modelVersion: string;
  schemaVersion: string;
  /** where the facts came from: 'jsonld' (no model) or 'model'. */
  method: "jsonld" | "model" | "hybrid";
}

// Confidence thresholds — guide 6.4: auto-publish high, cross-check medium,
// queue low. Calibrate against real precision later (do not trust raw model
// confidence — guide 6.4 "Calibration").
const AUTO = 0.85;
const REVIEW_FLOOR = 0.6;

/** Build offers straight from JSON-LD facts — highest-trust, no model cost. */
function offersFromJsonLd(obs: RawObservation): PipelineOffer[] {
  const jl = (obs.structuredHints as any)?.jsonld;
  if (!jl) return [];
  const out: PipelineOffer[] = [];
  for (const mi of jl.menuItems ?? []) {
    if (!mi.name) continue;
    out.push({
      entity_text: mi.name,
      canonical_entity_id: null,
      offer_type: "regular",
      pricing: mi.price != null ? { type: "regular", amount: mi.price, currency: mi.currency ?? "USD" } : { type: "unknown" },
      conditions: [],
      validity_start: null,
      validity_end: null,
      confidence: 0.97, // structured markup is direct evidence
      provenance: obs.provenance,
      evidence: [{ kind: "dom_element", locator: { source: "jsonld", section: mi.section }, text: mi.name }],
    });
  }
  for (const of of jl.offers ?? []) {
    out.push({
      entity_text: of.name ?? "offer",
      canonical_entity_id: null,
      offer_type: "sale",
      pricing: of.price != null ? { type: "sale", amount: of.price, currency: of.currency ?? "USD" } : { type: "unknown" },
      conditions: [],
      validity_start: of.validFrom ?? null,
      validity_end: of.validThrough ?? null,
      confidence: 0.95,
      provenance: obs.provenance,
      evidence: [{ kind: "dom_element", locator: { source: "jsonld" }, text: of.name }],
    });
  }
  return out;
}

/** Run the model extractor on the unstructured content of an observation. */
async function extractWithModel(
  obs: RawObservation,
  ctx: BusinessContext,
): Promise<{ result: ExtractionResult; modelVersion: string } | null> {
  if (!isLlmConfigured()) return null;
  const text = (obs.text ?? "").trim();
  const images = obs.media
    .filter((m) => m.type === "image" || m.type === "pdf")
    .slice(0, 6)
    .map((m) => ({ url: m.url, mediaType: m.type === "pdf" ? "application/pdf" : "image/jpeg" }));
  if (!text && images.length === 0) return null;

  const module = moduleFor(ctx.vertical);
  const llm = getLlm();
  const { data, modelVersion } = await llm.callStructured<unknown>({
    system: module.buildSystemPrompt(ctx),
    text: text || "Extract offers from the attached image(s)/menu.",
    images,
    schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    tier: "extract",
  });
  const parsed = ExtractionResult.safeParse(data);
  if (!parsed.success) {
    // Schema violation — treat as a warning-bearing empty result rather than crash.
    return {
      result: ExtractionResult.parse({
        content_intent: { value: "editorial", confidence: 0 },
        business_vertical: ctx.vertical,
        offers: [],
        warnings: ["model output failed schema validation: " + parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(", ")],
      }),
      modelVersion,
    };
  }
  return { result: { ...parsed.data, model_version: modelVersion }, modelVersion };
}

export async function runExtraction(
  obs: RawObservation,
  ctx: BusinessContext,
): Promise<PipelineOutput> {
  const module = moduleFor(ctx.vertical);
  const jsonLdOffers = offersFromJsonLd(obs);

  // The model pass is a best-effort ADDITION on top of high-trust structured
  // facts. If it throws (vision-image fetch failure, rate limit, timeout), degrade
  // to the jsonLd offers we already have — never let it escape, or a single bad
  // store cover-image discards the entire 400+ item menu it was attached to (this
  // is exactly why DoorDash menus with 457 parsed items were persisting 0 offers).
  let modelOut: Awaited<ReturnType<typeof extractWithModel>> = null;
  let modelError: string | undefined;
  try {
    modelOut = await extractWithModel(obs, ctx);
  } catch (e) {
    modelError = `model extraction failed: ${(e as Error).message}`;
  }

  // No model available and no structured markup → nothing to extract.
  if (!modelOut && jsonLdOffers.length === 0) {
    return {
      intent: "regular_menu",
      intentConfidence: 0,
      vertical: ctx.vertical,
      offers: [],
      warnings: isLlmConfigured() ? ["no extractable content"] : ["LLM not configured; only structured markup was used"],
      review: "confirmed",
      modelVersion: "none",
      schemaVersion: "1.0",
      method: jsonLdOffers.length ? "jsonld" : "model",
    };
  }

  let warnings: string[] = modelError ? [modelError] : [];
  let intent = "regular_menu";
  let intentConfidence = 0;
  let modelVersion = "none";
  const modelOffers: PipelineOffer[] = [];

  if (modelOut) {
    const validation = module.validate(modelOut.result, ctx);
    warnings = [...modelOut.result.warnings, ...validation.issues.map((i) => `${i.code}: ${i.message}`)];
    intent = modelOut.result.content_intent.value;
    intentConfidence = modelOut.result.content_intent.confidence;
    modelVersion = modelOut.modelVersion;

    const perOffer = validation.offerAdjustments ?? [];
    for (const [i, o] of modelOut.result.offers.entries()) {
      if (!o.entity_text?.trim()) continue; // drop items the model left blank
      const calibrated = clamp01(
        o.confidence * validation.confidenceAdjustment * (perOffer[i] ?? 1),
      );
      modelOffers.push({
        entity_text: o.entity_text,
        canonical_entity_id: o.canonical_entity_id ?? null,
        offer_type: o.pricing.type,
        pricing: o.pricing,
        conditions: o.conditions,
        validity_start: modelOut.result.validity?.start ?? null,
        validity_end: modelOut.result.validity?.end ?? null,
        confidence: calibrated,
        provenance: obs.provenance,
        evidence: o.evidence,
      });
    }
  }

  const offers = [...jsonLdOffers, ...modelOffers];
  const method: PipelineOutput["method"] =
    jsonLdOffers.length && modelOffers.length ? "hybrid" : jsonLdOffers.length ? "jsonld" : "model";

  // Route to human review if the strongest priced offer is below the floor
  // (guide 6.4). JSON-LD-only extractions are high trust and auto-confirm.
  const maxConf = offers.length ? Math.max(...offers.map((o) => o.confidence)) : 1;
  const review: ReviewStatus = maxConf < REVIEW_FLOOR ? "pending" : "confirmed";
  if (maxConf < AUTO && maxConf >= REVIEW_FLOOR) {
    warnings.push(`medium confidence (${maxConf.toFixed(2)}) — cross-check recommended`);
  }

  return {
    intent,
    intentConfidence,
    vertical: ctx.vertical,
    offers,
    warnings,
    review,
    modelVersion,
    schemaVersion: "1.0",
    method,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
