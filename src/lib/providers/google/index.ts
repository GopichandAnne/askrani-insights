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
 * Google adapter — public discovery (Places), Reviews and Photos.
 * Guide 3.1: "Public business/place discovery → Google Places API".
 *
 * Activates automatically when GOOGLE_MAPS_API_KEY is present; otherwise every
 * capability throws ProviderNotConfigured and the registry omits it, so
 * discovery falls back to website + OpenStreetMap. The authorized Google
 * Business Profile connector (owner-authorized reviews/posts/performance) is a
 * separate, OAuth-based path — tracked but not wired here.
 */
export class GoogleProvider implements PublicContentProvider {
  readonly name = "google";
  readonly provenance = "OFFICIAL_PUBLIC_API" as const;

  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();
  private get key() {
    return process.env.GOOGLE_MAPS_API_KEY ?? "";
  }

  isConfigured(): boolean {
    return this.key.length > 0;
  }

  private assert() {
    if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, "GOOGLE_MAPS_API_KEY");
  }

  /** Places API (New) Text Search — returns nearby candidate businesses. */
  async discoverProfiles(input: DiscoverInput): Promise<ProfileCandidate[]> {
    this.assert();
    const body: Record<string, unknown> = {
      textQuery: input.query ?? "",
      maxResultCount: Math.min(input.limit ?? 20, 20),
    };
    if (input.near) {
      body.locationBias = {
        circle: {
          center: { latitude: input.near.lat, longitude: input.near.lng },
          radius: (input.near.radiusKm ?? 5) * 1000,
        },
      };
    }
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": this.key,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.primaryType",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`google places ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    const maxRatings = Math.max(1, ...(data.places ?? []).map((p: any) => p.userRatingCount ?? 0));
    return (data.places ?? []).map((p: any): ProfileCandidate => ({
      name: p.displayName?.text ?? "",
      platform: "google",
      externalId: p.id,
      url: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      website: p.websiteUri,
      geo: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
      category: p.primaryType,
      prominence: (p.userRatingCount ?? 0) / maxRatings,
      confidence: 0.85,
      raw: p,
    }));
  }

  async collectProfiles(_input: ProfileBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectProfiles");
  }

  /**
   * Collect Reviews + Photos via Place Details. `input.urls` carries place IDs
   * (or place_id: URLs). Reviews returned by the public API are capped (≈5);
   * we retain source URL and never imply completeness (guide 3.1 reviews rule).
   */
  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    this.assert();
    const jobId = `google_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    this.jobs.set(jobId, {
      status: { jobId, provider: this.name, status: "running" },
      results: [],
    });

    (async () => {
      const out: RawObservation[] = [];
      const errors: string[] = [];
      for (const ref of input.urls) {
        const placeId = ref.replace(/^.*place_id:/, "").trim();
        try {
          const res = await fetch(
            `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
            {
              headers: {
                "X-Goog-Api-Key": this.key,
                "X-Goog-FieldMask":
                  "id,displayName,rating,userRatingCount,reviews,photos,websiteUri",
              },
            },
          );
          if (!res.ok) {
            errors.push(`${placeId}: ${res.status}`);
            continue;
          }
          const p = (await res.json()) as any;
          const now = new Date().toISOString();
          for (const rev of p.reviews ?? []) {
            const text = rev.text?.text ?? rev.originalText?.text ?? "";
            out.push({
              provider: this.name,
              provenance: "OFFICIAL_PUBLIC_API",
              platform: "google",
              contentKind: "review",
              externalRef: rev.name,
              sourceUrl: rev.googleMapsUri ?? p.websiteUri,
              businessHint: { name: p.displayName?.text },
              text,
              media: [],
              publishedAt: rev.publishTime,
              observedAt: now,
              contentHash: createHash("sha256")
                .update(`${rev.name}|${text}`)
                .digest("hex"),
              raw: rev,
              structuredHints: { rating: rev.rating, authorRatingCount: p.userRatingCount },
            });
          }
        } catch (e) {
          errors.push(`${placeId}: ${(e as Error).message}`);
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
    return (
      this.jobs.get(jobId)?.status ?? {
        jobId,
        provider: this.name,
        status: "failed",
        error: "unknown job",
      }
    );
  }

  async *fetchResults(jobId: string): AsyncIterable<RawObservation> {
    for (const obs of this.jobs.get(jobId)?.results ?? []) yield obs;
  }

  async estimateCost(input: ProviderRequest): Promise<CostEstimate> {
    // Places API (New) is billed per request by SKU; treat as a rough guide and
    // reconcile against real usage in provider_run (guide 16.1 note).
    const perReq = 0.017;
    return {
      provider: this.name,
      currency: "USD",
      estimatedUsd: (input.count ?? 1) * perReq,
      basis: "≈$17 / 1000 Places requests (SKU-dependent)",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      ok: this.isConfigured(),
      configured: this.isConfigured(),
      detail: this.isConfigured() ? undefined : "GOOGLE_MAPS_API_KEY not set",
      checkedAt: new Date().toISOString(),
    };
  }
}
