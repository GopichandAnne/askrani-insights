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
 * Healthcare / local-services DIRECTORY adapters — Healthgrades, Zocdoc (and any
 * future Vitals / RateMDs). Unlike Google/Yelp these have no official API, so
 * they're Apify-backed and DORMANT until an Actor id is configured — the same
 * user-owned activation model as the social/delivery platforms.
 *
 * For dental (and future medical verticals) these are where reputation + accepted
 * INSURANCE actually live — a bigger purchase driver than sticker price. Each
 * profile scrape emits, as normalized review observations:
 *   • a rating summary ("Rated 4.7★ on Healthgrades from 128 reviews") — parsed by
 *     report.ts into a per-source reputation row (so Healthgrades/Zocdoc show up
 *     alongside Google/Yelp and feed the scorecard Rating ring),
 *   • the accepted-insurance list (a citable source for "do they take my plan?"),
 *   • individual review text (feeds the review-pulse / competitor-gripe mining).
 *
 * Actor ids are env-required (NO default) because directory scraping is paid and
 * ToS-sensitive; field mappers read several likely key names defensively because
 * community Actor output shapes vary (mirrors the delivery mappers).
 */

const num = (x: unknown): number | undefined => {
  const n = Number(String(x ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const firstNum = (o: any, keys: string[]): number | undefined => {
  for (const k of keys) { const v = num(o?.[k]); if (v != null) return v; }
  return undefined;
};
const firstStr = (o: any, keys: string[]): string | undefined => {
  for (const k of keys) { const v = o?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return undefined;
};
const asArray = (x: unknown): any[] => (Array.isArray(x) ? x : []);

/** Run an Apify actor, poll to completion within a time budget, return dataset items. */
async function runApifyActor(actor: string, input: Record<string, unknown>, maxMs: number): Promise<{ items: any[]; costUsd: number; error?: string }> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { items: [], costUsd: 0, error: "APIFY_TOKEN not set" };
  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (!runRes.ok) return { items: [], costUsd: 0, error: `run start ${runRes.status}: ${(await runRes.text().catch(() => "")).slice(0, 140)}` };
    const runId = ((await runRes.json()) as any).data?.id;
    if (!runId) return { items: [], costUsd: 0, error: "run start: no run id" };
    const deadline = Date.now() + maxMs;
    let datasetId: string | undefined, costUsd = 0;
    while (Date.now() < deadline) {
      const st = (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json())) as any;
      const s = st.data?.status;
      costUsd = st.data?.usageTotalUsd ?? costUsd;
      if (s === "SUCCEEDED") { datasetId = st.data?.defaultDatasetId; break; }
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return { items: [], costUsd, error: `run ${s}` };
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return { items: [], costUsd, error: "run still going past time budget" };
    const raw = (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`).then((r) => r.json())) as any[];
    return { items: Array.isArray(raw) ? raw : [], costUsd };
  } catch (e) {
    return { items: [], costUsd: 0, error: (e as Error).message };
  }
}

interface DirectoryConfig {
  name: string;                 // provider name + platform key (e.g. "healthgrades")
  label: string;                // human name in the rating summary text
  host: string;                 // profile URL host, for a light sanity check
  searchActor: () => string | undefined;   // finds a profile by name+location (optional capability)
  reviewsActor: () => string | undefined;  // scrapes a profile URL → rating + reviews + insurance
  searchInput: (query: string, near?: { lat: number; lng: number }) => Record<string, unknown>;
  reviewsInput: (profileUrl: string) => Record<string, unknown>;
}

// Insurance / accepted-payer field names vary; read several. Kept as a list of
// strings (payer names) so downstream can show "takes Delta Dental, Cigna…".
function insurancesOf(o: any): string[] {
  const raw = o?.insurances ?? o?.insurance ?? o?.insuranceAccepted ?? o?.acceptedInsurances ?? o?.insurancePlans ?? o?.accepted_insurances;
  return asArray(raw).map((x) => (typeof x === "string" ? x : x?.name ?? x?.plan ?? x?.title)).filter((s): s is string => !!s && typeof s === "string").slice(0, 40);
}
function reviewsOf(o: any): any[] {
  return asArray(o?.reviews ?? o?.reviewList ?? o?.reviewsData ?? o?.patientReviews).slice(0, 8);
}

class ApifyDirectoryProvider implements PublicContentProvider {
  readonly provenance = "MANAGED_PUBLIC_PROVIDER_APIFY" as const;
  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();
  constructor(private cfg: DirectoryConfig) {}

  get name() { return this.cfg.name; }
  isConfigured(): boolean { return !!process.env.APIFY_TOKEN && !!this.cfg.reviewsActor(); }
  private assert() { if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, `APIFY_TOKEN + ${this.name} actor`); }

  /** Find the practice's directory profile by name+location (only if a search Actor
   *  is configured; otherwise the profile URL must be attached in Channels). */
  async discoverProfiles(input: DiscoverInput): Promise<ProfileCandidate[]> {
    const actor = this.cfg.searchActor();
    if (!process.env.APIFY_TOKEN || !actor) throw new UnsupportedCapability(this.name, "discoverProfiles");
    const { items } = await runApifyActor(actor, this.cfg.searchInput(input.query ?? "", input.near), 45000);
    return items.slice(0, input.limit ?? 5).map((it): ProfileCandidate => ({
      name: firstStr(it, ["name", "practiceName", "title", "providerName"]) ?? input.query ?? this.cfg.label,
      platform: this.name,
      externalId: firstStr(it, ["url", "profileUrl", "link", "href"]),
      url: firstStr(it, ["url", "profileUrl", "link", "href"]),
      category: firstStr(it, ["specialty", "specialties", "category"]),
      prominence: (firstNum(it, ["reviewCount", "totalReviews", "numReviews", "ratingCount"]) ?? 0) / 500,
      confidence: 0.6,
      raw: it,
    }));
  }

  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectProfiles");
  }

  /** input.urls = directory profile URL(s) → scrape rating + reviews + insurance. */
  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    this.assert();
    const actor = this.cfg.reviewsActor()!;
    const jobId = `${this.name}_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    this.jobs.set(jobId, { status: { jobId, provider: this.name, status: "running" }, results: [] });

    (async () => {
      const out: RawObservation[] = [];
      const errors: string[] = [];
      let costUsd = 0;
      const now = new Date().toISOString();
      for (const url of input.urls) {
        const { items, costUsd: c, error } = await runApifyActor(actor, this.cfg.reviewsInput(url), 90000);
        costUsd += c;
        if (error) { errors.push(error); continue; }
        const profile = items[0];
        if (!profile) continue;
        const rating = firstNum(profile, ["rating", "overallRating", "starRating", "averageRating", "score"]);
        const reviewCount = firstNum(profile, ["reviewCount", "totalReviews", "numReviews", "ratingCount", "reviewsCount"]);
        const pname = firstStr(profile, ["name", "practiceName", "title", "providerName"]) ?? this.cfg.label;

        // 1) rating summary — the exact "Rated X★ … from Y reviews" shape report.ts parses
        if (rating != null) {
          const text = `Rated ${rating}★ on ${this.cfg.label} from ${reviewCount ?? 0} reviews.`;
          out.push({
            provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "review",
            externalRef: `${url}#rating`, sourceUrl: url, text, media: [], observedAt: now,
            contentHash: createHash("sha256").update(`${url}|${rating}|${reviewCount}`).digest("hex"),
            raw: { rating, reviewCount }, structuredHints: { kind: "rating_summary", rating, review_count: reviewCount },
          });
        }

        // 2) accepted insurance — a citable "do they take my plan?" source
        const insurances = insurancesOf(profile);
        if (insurances.length) {
          const text = `Insurance accepted (per ${this.cfg.label}): ${insurances.join(", ")}.`;
          out.push({
            provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "profile",
            externalRef: `${url}#insurance`, sourceUrl: url, text, media: [], observedAt: now,
            contentHash: createHash("sha256").update(`${url}|ins|${insurances.join(",")}`).digest("hex"),
            raw: { insurances }, structuredHints: { kind: "insurance_accepted", insurances },
          });
        }

        // 3) individual review text — feeds review-pulse + competitor-gripe mining
        for (const rev of reviewsOf(profile)) {
          const text = firstStr(rev, ["text", "comment", "reviewText", "body", "content"]);
          if (!text) continue;
          const rid = firstStr(rev, ["id", "reviewId", "url"]) ?? createHash("sha256").update(text).digest("hex").slice(0, 16);
          out.push({
            provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "review",
            externalRef: `${url}#${rid}`, sourceUrl: firstStr(rev, ["url"]) ?? url, text,
            media: [], publishedAt: firstStr(rev, ["date", "publishedAt", "createdAt", "time"]), observedAt: now,
            contentHash: createHash("sha256").update(`${rid}|${text}`).digest("hex"),
            raw: rev, structuredHints: { rating: firstNum(rev, ["rating", "stars", "score"]) },
          });
        }
        // pull the practice name back for the caller's benefit via the first summary
        void pname;
      }
      const job = this.jobs.get(jobId)!;
      job.results = out;
      job.status = {
        jobId, provider: this.name,
        status: out.length ? "succeeded" : errors.length ? "failed" : "partial",
        resultCount: out.length, costUsd,
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
  async estimateCost(_input: ProviderRequest): Promise<CostEstimate> {
    return { provider: this.name, currency: "USD", estimatedUsd: 0, basis: `Apify actor for ${this.cfg.label} (metered per run)`, note: "Verify the Actor's per-run cost + terms before heavy use." };
  }
  async healthCheck(): Promise<ProviderHealth> {
    const ok = this.isConfigured();
    return { provider: this.name, ok, configured: ok, detail: ok ? undefined : `APIFY_TOKEN + ${this.name.toUpperCase()}_REVIEWS_ACTOR not set`, checkedAt: new Date().toISOString() };
  }
}

// ── concrete directories ────────────────────────────────────────────────────
// Actor ids are env-required (no default) — the provider stays dormant until set.
// Search is optional; if no search Actor is configured, attach the profile URL in
// Channels and only the reviews Actor is needed.
export class HealthgradesProvider extends ApifyDirectoryProvider {
  constructor() {
    super({
      name: "healthgrades", label: "Healthgrades", host: "healthgrades.com",
      searchActor: () => process.env.HEALTHGRADES_SEARCH_ACTOR,
      reviewsActor: () => process.env.HEALTHGRADES_REVIEWS_ACTOR ?? process.env.HEALTHGRADES_ACTOR,
      searchInput: (query, near) => ({ search: query, query, location: near ? `${near.lat},${near.lng}` : "", maxItems: 5 }),
      reviewsInput: (url) => ({ startUrls: [{ url }], maxReviews: 20, includeReviews: true }),
    });
  }
}
export class ZocdocProvider extends ApifyDirectoryProvider {
  constructor() {
    super({
      name: "zocdoc", label: "Zocdoc", host: "zocdoc.com",
      searchActor: () => process.env.ZOCDOC_SEARCH_ACTOR,
      reviewsActor: () => process.env.ZOCDOC_REVIEWS_ACTOR ?? process.env.ZOCDOC_ACTOR,
      searchInput: (query, near) => ({ search: query, query, location: near ? `${near.lat},${near.lng}` : "", maxItems: 5 }),
      reviewsInput: (url) => ({ startUrls: [{ url }], maxReviews: 20, includeReviews: true }),
    });
  }
}
