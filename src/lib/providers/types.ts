/**
 * Provider adapter contract — guide Appendix A.
 *
 * Every external data source (website, Google, Apify, Bright Data, Meta…)
 * implements this interface. Downstream services NEVER see provider-specific
 * response shapes: adapters convert their native records into `RawObservation`
 * before anything leaves the ingestion boundary (guide 3.2, 8.2).
 *
 * This is what makes "every external data source is replaceable" (guide
 * Strategic Decisions) true in code rather than in a slide.
 */

export type Provenance =
  | "OWNER_AUTHORIZED_API"
  | "OFFICIAL_PUBLIC_API"
  | "META_BUSINESS_DISCOVERY"
  | "MANAGED_PUBLIC_PROVIDER_APIFY"
  | "LICENSED_DATASET_BRIGHTDATA"
  | "PUBLIC_WEBSITE_HTTP"
  | "PUBLIC_WEBSITE_BROWSER"
  | "USER_SUBMITTED"
  | "MANUAL_ANALYST"
  | "INFERRED_FROM_MULTIPLE_SOURCES";

export type ContentKind =
  | "post"
  | "page"
  | "menu"
  | "flyer"
  | "review"
  | "photo"
  | "event"
  | "profile";

export interface MediaRef {
  type: "image" | "video" | "pdf" | "audio";
  url?: string;
  storagePath?: string;
  perceptualHash?: string;
}

/**
 * The normalized, provider-agnostic unit produced by every adapter. This is the
 * ONLY shape ingestion persists — a provider swap changes adapters, not this.
 */
export interface RawObservation {
  provider: string;
  provenance: Provenance;
  platform: string; // instagram | website | google | pdf ...
  contentKind: ContentKind;
  externalRef?: string; // post id / page url / place id
  sourceUrl?: string;
  businessHint?: {
    name?: string;
    website?: string;
    handle?: string;
  };
  text?: string;
  media: MediaRef[];
  publishedAt?: string; // ISO 8601
  observedAt: string; // ISO 8601
  contentHash: string; // dedup across customers (guide 16.3)
  raw: unknown; // opaque original payload, stored separately
  structuredHints?: Record<string, unknown>; // e.g. JSON-LD facts already parsed
}

export interface ProfileCandidate {
  name: string;
  platform: string;
  externalId?: string;
  url?: string;
  handle?: string;
  website?: string;
  geo?: { lat: number; lng: number };
  distanceKm?: number;
  category?: string;
  prominence?: number; // review count / follower proxy, 0..1 normalized
  score?: number;
  confidence?: number;
  raw?: unknown;
}

export interface DiscoverInput {
  query?: string;
  near?: { lat: number; lng: number; radiusKm?: number };
  vertical?: string;
  limit?: number;
}

export interface ProfileBatch {
  urls?: string[];
  handles?: string[];
  businessIds?: string[];
  limit?: number;
}

export interface ContentBatch {
  urls: string[];
  resultsLimit?: number;
  since?: string; // ISO 8601 incremental cursor
}

export interface ProviderRequest {
  kind: "discover" | "collectProfiles" | "collectContent";
  count?: number;
  input?: unknown;
}

export interface CostEstimate {
  provider: string;
  currency: "USD";
  estimatedUsd: number;
  basis: string; // e.g. "$1.50 / 1000 results"
  note?: string;
}

export interface ProviderJob {
  jobId: string;
  provider: string;
  status: ProviderJobStatus["status"];
  submittedAt: string;
}

export interface ProviderJobStatus {
  jobId: string;
  provider: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  resultCount?: number;
  costUsd?: number;
  error?: string;
}

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  configured: boolean; // false when required keys are absent
  detail?: string;
  checkedAt: string;
}

/**
 * The adapter surface. Adapters that don't support a capability throw
 * `UnsupportedCapability` (e.g. the website adapter can collect content but does
 * not "discover profiles" on social platforms).
 */
export interface PublicContentProvider {
  readonly name: string;
  readonly provenance: Provenance;

  /** Is this adapter usable right now (keys present, etc.)? */
  isConfigured(): boolean;

  discoverProfiles(input: DiscoverInput): Promise<ProfileCandidate[]>;
  collectProfiles(input: ProfileBatch): Promise<ProviderJob>;
  collectContent(input: ContentBatch): Promise<ProviderJob>;
  getJob(jobId: string): Promise<ProviderJobStatus>;
  fetchResults(jobId: string, cursor?: string): AsyncIterable<RawObservation>;
  estimateCost(input: ProviderRequest): Promise<CostEstimate>;
  healthCheck(): Promise<ProviderHealth>;
}

export class UnsupportedCapability extends Error {
  constructor(provider: string, capability: string) {
    super(`${provider} does not support ${capability}`);
    this.name = "UnsupportedCapability";
  }
}

export class ProviderNotConfigured extends Error {
  constructor(provider: string, missing: string) {
    super(`${provider} is not configured (missing ${missing})`);
    this.name = "ProviderNotConfigured";
  }
}
