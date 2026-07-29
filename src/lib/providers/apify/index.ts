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
import { createHash } from "node:crypto";

/**
 * Apify adapter — managed public collection for IG/FB/TikTok (guide 3.2).
 * Submits an Actor run, polls, then streams the dataset. Activated by
 * APIFY_TOKEN. Actor id is configurable so we can swap Actors without touching
 * downstream code (guide 3.2: "one task per provider config, not per customer").
 *
 * Cost note (guide 3.2): pricing is a moving target (~$2.70/1k free tier at time
 * of writing). We record actual cost per run in provider_run rather than trust a
 * hard-coded number (guide 16.1).
 */
export class ApifyProvider implements PublicContentProvider {
  readonly name = "apify";
  readonly provenance = "MANAGED_PUBLIC_PROVIDER_APIFY" as const;

  private actorId = process.env.APIFY_INSTAGRAM_ACTOR ?? "apify~instagram-scraper";
  private get token() {
    return process.env.APIFY_TOKEN ?? "";
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }
  private assert() {
    if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, "APIFY_TOKEN");
  }

  async discoverProfiles(_input: DiscoverInput): Promise<ProfileCandidate[]> {
    // Discovery via hashtag/search Actors is possible but noisy; we prefer
    // Google/website discovery and use Apify to COLLECT known profiles.
    return [];
  }

  async collectProfiles(input: ProfileBatch): Promise<ProviderJob> {
    return this.startRun({
      directUrls: (input.urls ?? input.handles ?? []).map(toIgUrl),
      resultsType: "details",
      resultsLimit: input.limit ?? 1,
    });
  }

  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    // Batch multiple public profile URLs into a single run (guide 3.2).
    return this.startRun({
      directUrls: input.urls.map(toIgUrl),
      resultsType: "posts",
      resultsLimit: input.resultsLimit ?? 20,
    });
  }

  private async startRun(inputPayload: Record<string, unknown>): Promise<ProviderJob> {
    this.assert();
    const res = await fetch(
      `https://api.apify.com/v2/acts/${this.actorId}/runs?token=${this.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inputPayload),
      },
    );
    if (!res.ok) throw new Error(`apify run ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return {
      jobId: data.data.id,
      provider: this.name,
      status: "running",
      submittedAt: new Date().toISOString(),
    };
  }

  async getJob(jobId: string): Promise<ProviderJobStatus> {
    this.assert();
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${jobId}?token=${this.token}`);
    if (!res.ok) return { jobId, provider: this.name, status: "failed", error: `${res.status}` };
    const d = (await res.json()) as any;
    const map: Record<string, ProviderJobStatus["status"]> = {
      READY: "queued",
      RUNNING: "running",
      SUCCEEDED: "succeeded",
      FAILED: "failed",
      ABORTED: "failed",
      TIMED_OUT: "partial",
    };
    return {
      jobId,
      provider: this.name,
      status: map[d.data.status] ?? "running",
      resultCount: d.data.stats?.datasetItemCount,
      costUsd: d.data.usageTotalUsd,
    };
  }

  async *fetchResults(jobId: string): AsyncIterable<RawObservation> {
    this.assert();
    const run = await fetch(
      `https://api.apify.com/v2/actor-runs/${jobId}?token=${this.token}`,
    ).then((r) => r.json() as any);
    const datasetId = run.data?.defaultDatasetId;
    if (!datasetId) return;
    const items = (await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${this.token}&clean=true`,
    ).then((r) => r.json())) as any[];
    const now = new Date().toISOString();
    for (const it of items) {
      const text = it.caption ?? it.text ?? "";
      const url = it.url ?? it.postUrl;
      yield {
        provider: this.name,
        provenance: this.provenance,
        platform: "instagram",
        contentKind: "post",
        externalRef: it.id ?? it.shortCode ?? url,
        sourceUrl: url,
        businessHint: { handle: it.ownerUsername, name: it.ownerFullName },
        text,
        media: mediaFromApifyItem(it),
        publishedAt: it.timestamp,
        observedAt: now,
        contentHash: createHash("sha256").update(`${it.id ?? url}|${text}`).digest("hex"),
        raw: it,
        structuredHints: { likes: it.likesCount, comments: it.commentsCount, type: it.type },
      };
    }
  }

  async estimateCost(input: ProviderRequest): Promise<CostEstimate> {
    const per1k = 2.7; // snapshot; reconcile against provider_run
    return {
      provider: this.name,
      currency: "USD",
      estimatedUsd: ((input.count ?? 20) / 1000) * per1k,
      basis: "≈$2.70 / 1000 results (snapshot — verify live)",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      ok: this.isConfigured(),
      configured: this.isConfigured(),
      detail: this.isConfigured() ? undefined : "APIFY_TOKEN not set",
      checkedAt: new Date().toISOString(),
    };
  }
}

function toIgUrl(u: string): string {
  if (/^https?:\/\//.test(u)) return u;
  return `https://www.instagram.com/${u.replace(/^@/, "")}/`;
}

function mediaFromApifyItem(it: any) {
  const media: RawObservation["media"] = [];
  if (it.displayUrl) media.push({ type: "image", url: it.displayUrl });
  for (const img of it.images ?? []) media.push({ type: "image", url: img });
  if (it.videoUrl) media.push({ type: "video", url: it.videoUrl });
  return media;
}
