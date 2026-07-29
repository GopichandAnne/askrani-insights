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
  UnsupportedCapability,
} from "../types";
import { createHash } from "node:crypto";

/**
 * Yelp Fusion adapter — official public API for business discovery + reviews
 * (guide §3.1 reviews: "Yelp Fusion/API"). Activates with YELP_API_KEY. Fusion
 * returns up to 3 review excerpts per business (we retain the source URL and
 * never imply completeness).
 */
export class YelpProvider implements PublicContentProvider {
  readonly name = "yelp";
  readonly provenance = "OFFICIAL_PUBLIC_API" as const;

  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();
  private get key() {
    return process.env.YELP_API_KEY ?? "";
  }
  private headers() {
    return { authorization: `Bearer ${this.key}`, accept: "application/json" };
  }
  isConfigured(): boolean {
    return this.key.length > 0;
  }
  private assert() {
    if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, "YELP_API_KEY");
  }

  /** Find candidate businesses by name/location or coordinates. */
  async discoverProfiles(input: DiscoverInput): Promise<ProfileCandidate[]> {
    this.assert();
    const u = new URL("https://api.yelp.com/v3/businesses/search");
    if (input.query) u.searchParams.set("term", input.query);
    if (input.near) {
      u.searchParams.set("latitude", String(input.near.lat));
      u.searchParams.set("longitude", String(input.near.lng));
      if (input.near.radiusKm) u.searchParams.set("radius", String(Math.min(Math.round(input.near.radiusKm * 1000), 40000)));
    } else {
      u.searchParams.set("location", input.query ?? "");
    }
    u.searchParams.set("limit", String(Math.min(input.limit ?? 10, 20)));
    const res = await fetch(u, { headers: this.headers() });
    if (!res.ok) throw new Error(`yelp search ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    const maxRatings = Math.max(1, ...(data.businesses ?? []).map((b: any) => b.review_count ?? 0));
    return (data.businesses ?? []).map((b: any): ProfileCandidate => ({
      name: b.name,
      platform: "yelp",
      externalId: b.id, // yelp alias/id used for the reviews endpoint
      url: b.url,
      website: undefined, // Yelp doesn't return the business's own site
      geo: b.coordinates ? { lat: b.coordinates.latitude, lng: b.coordinates.longitude } : undefined,
      category: (b.categories ?? []).map((c: any) => c.title).join(", "),
      prominence: (b.review_count ?? 0) / maxRatings,
      confidence: 0.8,
      raw: b,
    }));
  }

  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectProfiles");
  }

  /** input.urls carries Yelp business ids/aliases → fetch their reviews. */
  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    this.assert();
    const jobId = `yelp_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    this.jobs.set(jobId, { status: { jobId, provider: this.name, status: "running" }, results: [] });

    (async () => {
      const out: RawObservation[] = [];
      const errors: string[] = [];
      const now = new Date().toISOString();
      for (const id of input.urls) {
        try {
          const res = await fetch(`https://api.yelp.com/v3/businesses/${encodeURIComponent(id)}/reviews?limit=20&sort_by=yelp_sort`, {
            headers: this.headers(),
          });
          if (!res.ok) {
            errors.push(`${id}: ${res.status}`);
            continue;
          }
          const data = (await res.json()) as any;
          for (const rev of data.reviews ?? []) {
            const text = rev.text ?? "";
            out.push({
              provider: this.name,
              provenance: "OFFICIAL_PUBLIC_API",
              platform: "yelp",
              contentKind: "review",
              externalRef: rev.id,
              sourceUrl: rev.url,
              text,
              media: [],
              publishedAt: rev.time_created,
              observedAt: now,
              contentHash: createHash("sha256").update(`${rev.id}|${text}`).digest("hex"),
              raw: rev,
              structuredHints: { rating: rev.rating },
            });
          }
        } catch (e) {
          errors.push(`${id}: ${(e as Error).message}`);
        }
      }
      const job = this.jobs.get(jobId)!;
      job.results = out;
      job.status = {
        jobId,
        provider: this.name,
        status: out.length ? "succeeded" : errors.length ? "failed" : "partial",
        resultCount: out.length,
        error: errors.length ? errors.slice(0, 5).join("; ") : undefined,
      };
    })();

    return { jobId, provider: this.name, status: "running", submittedAt: new Date().toISOString() };
  }

  async getJob(jobId: string): Promise<ProviderJobStatus> {
    return this.jobs.get(jobId)?.status ?? { jobId, provider: this.name, status: "failed", error: "unknown job" };
  }
  async *fetchResults(jobId: string): AsyncIterable<RawObservation> {
    for (const obs of this.jobs.get(jobId)?.results ?? []) yield obs;
  }
  async estimateCost(input: ProviderRequest): Promise<CostEstimate> {
    return {
      provider: this.name,
      currency: "USD",
      estimatedUsd: 0,
      basis: "Yelp Fusion free tier (rate-limited); paid tiers vary",
      note: "Confirm current Yelp API terms/quota before heavy use.",
    };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      ok: this.isConfigured(),
      configured: this.isConfigured(),
      detail: this.isConfigured() ? undefined : "YELP_API_KEY not set",
      checkedAt: new Date().toISOString(),
    };
  }
}
