import type { ExtractionResult } from "./contract";

/**
 * Vertical module interface — guide 7.1 shared interface. Each vertical plugs in
 * its taxonomy, extraction guidance and validation rules behind this contract so
 * the pipeline stays vertical-agnostic and new verticals (7.4) drop in cleanly.
 */

export interface BusinessContext {
  businessId?: string;
  name?: string;
  vertical: string;
  timezone?: string;
  location?: { lat: number; lng: number };
  knownEntities?: string[]; // menu/catalog names + aliases for linking
  postPublishedAt?: string;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: "warn" | "error";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** result-level confidence multiplier, applied to every offer (guide 6.4). */
  confidenceAdjustment: number;
  /** per-offer multipliers, index-aligned to result.offers — so one bad offer
   *  doesn't drag down the confidence of its clean siblings. */
  offerAdjustments?: number[];
}

export interface VerticalModule {
  readonly vertical: string;
  /** Intent classes this vertical recognizes (guide 7.3 campaign types). */
  readonly intents: readonly string[];
  /** System prompt for the extractor, specialized to this vertical (Appendix C). */
  buildSystemPrompt(ctx: BusinessContext): string;
  /** Deterministic post-extraction validation (guide 6.4 range/catalog checks). */
  validate(result: ExtractionResult, ctx: BusinessContext): ValidationResult;
}
