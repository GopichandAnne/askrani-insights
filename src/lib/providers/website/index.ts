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
  UnsupportedCapability,
} from "../types";
import { crawlWebsite, type CrawlCacheEntry } from "./crawler";

/**
 * Website adapter. Wraps the crawler in the PublicContentProvider contract.
 *
 * The pilot runs crawls inline and holds results in an in-memory job store.
 * In production this maps onto a Temporal `CollectIncrementalContent` activity
 * (guide 5.3) with the conditional-GET cache persisted per source. That swap is
 * isolated to this file — nothing downstream depends on how jobs are run.
 */
export class WebsiteProvider implements PublicContentProvider {
  readonly name = "website";
  readonly provenance = "PUBLIC_WEBSITE_HTTP" as const;

  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();
  private caches = new Map<string, Map<string, CrawlCacheEntry>>();

  isConfigured(): boolean {
    return true; // needs no keys — the always-available baseline source
  }

  async discoverProfiles(_input: DiscoverInput): Promise<ProfileCandidate[]> {
    // Website discovery from a free-text query needs a place/search index;
    // that lives in the Google/OSM adapters. Website adapter only collects
    // from URLs it is given.
    throw new UnsupportedCapability(this.name, "discoverProfiles");
  }

  async collectProfiles(_input: ProfileBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectProfiles");
  }

  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    const jobId = `website_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    const submittedAt = new Date().toISOString();
    this.jobs.set(jobId, {
      status: { jobId, provider: this.name, status: "running" },
      results: [],
    });

    // run crawls (bounded) — inline for the pilot
    (async () => {
      const all: RawObservation[] = [];
      const errors: string[] = [];
      for (const url of input.urls) {
        let cache = this.caches.get(url);
        if (!cache) {
          cache = new Map();
          this.caches.set(url, cache);
        }
        try {
          const r = await crawlWebsite(url, {
            maxPages: 25,
            cache,
          });
          all.push(...r.observations);
          errors.push(...r.errors);
        } catch (e) {
          errors.push(`${url}: ${(e as Error).message}`);
        }
      }
      const job = this.jobs.get(jobId)!;
      job.results = all;
      job.status = {
        jobId,
        provider: this.name,
        status: errors.length && !all.length ? "failed" : all.length ? "succeeded" : "partial",
        resultCount: all.length,
        costUsd: 0,
        error: errors.length ? errors.slice(0, 5).join("; ") : undefined,
      };
    })();

    return { jobId, provider: this.name, status: "running", submittedAt };
  }

  async getJob(jobId: string): Promise<ProviderJobStatus> {
    const job = this.jobs.get(jobId);
    if (!job) return { jobId, provider: this.name, status: "failed", error: "unknown job" };
    return job.status;
  }

  async *fetchResults(jobId: string): AsyncIterable<RawObservation> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const obs of job.results) yield obs;
  }

  async estimateCost(_input: ProviderRequest): Promise<CostEstimate> {
    return {
      provider: this.name,
      currency: "USD",
      estimatedUsd: 0,
      basis: "direct HTTP crawl — no vendor cost",
      note: "Bandwidth/compute only; the cheapest source in the hierarchy (guide 5.1).",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      ok: true,
      configured: true,
      checkedAt: new Date().toISOString(),
    };
  }
}
