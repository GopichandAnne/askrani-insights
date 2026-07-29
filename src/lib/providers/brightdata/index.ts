import {
  PublicContentProvider,
  DiscoverInput,
  ProfileBatch,
  ContentBatch,
  ProviderJob,
  ProviderJobStatus,
  ProviderHealth,
  ProviderRequest,
  CostEstimate,
  ProfileCandidate,
  RawObservation,
  ProviderNotConfigured,
} from "../types";

/**
 * Bright Data adapter — enterprise fallback + datasets (guide 3.3).
 *
 * Two modes: Scraper API (on-demand fallback when Apify fails twice / returns
 * incomplete fields) and Datasets (bulk historical/contractual backfill loaded
 * to an S3/Storage quarantine prefix, scanned, then normalized through the same
 * pipeline). The dataset delivery shape is contract-specific, so this ships as a
 * conformant skeleton: it activates on BRIGHTDATA_API_TOKEN and the trigger
 * routing lives in collection-service, but the delivery parser is wired per
 * signed contract (guide 3.3: obtain sample + written permitted-use first).
 */
export class BrightDataProvider implements PublicContentProvider {
  readonly name = "brightdata";
  readonly provenance = "LICENSED_DATASET_BRIGHTDATA" as const;

  private get token() {
    return process.env.BRIGHTDATA_API_TOKEN ?? "";
  }
  isConfigured(): boolean {
    return this.token.length > 0;
  }
  private assert() {
    if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, "BRIGHTDATA_API_TOKEN");
  }

  async discoverProfiles(_i: DiscoverInput): Promise<ProfileCandidate[]> {
    return [];
  }
  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> {
    this.assert();
    throw new Error("brightdata delivery parser is wired per signed dataset contract (guide 3.3)");
  }
  async collectContent(_i: ContentBatch): Promise<ProviderJob> {
    this.assert();
    throw new Error("brightdata delivery parser is wired per signed dataset contract (guide 3.3)");
  }
  async getJob(jobId: string): Promise<ProviderJobStatus> {
    return { jobId, provider: this.name, status: "failed", error: "not wired" };
  }
  async *fetchResults(): AsyncIterable<RawObservation> {
    /* per-contract */
  }
  async estimateCost(input: ProviderRequest): Promise<CostEstimate> {
    const per1k = 1.5; // PAYG snapshot; datasets ≈ $250 / 100k (guide 3.3)
    return {
      provider: this.name,
      currency: "USD",
      estimatedUsd: ((input.count ?? 1000) / 1000) * per1k,
      basis: "≈$1.50 / 1000 delivered (PAYG) or ≈$250 / 100k (dataset) — verify",
    };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      ok: this.isConfigured(),
      configured: this.isConfigured(),
      detail: this.isConfigured() ? "skeleton — delivery parser per contract" : "BRIGHTDATA_API_TOKEN not set",
      checkedAt: new Date().toISOString(),
    };
  }
}
