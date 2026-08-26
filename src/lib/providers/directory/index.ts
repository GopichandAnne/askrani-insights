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
import { createHash } from "node:crypto";

/**
 * Healthgrades reader — FETCH-BASED, no Apify. Healthgrades serves the full
 * provider profile — aggregateRating + patient reviews — as JSON-LD in the page
 * HTML, and a plain server fetch returns HTTP 200 (verified: rating + reviewCount
 * + reviewBody all present). So we read it exactly like a website: fetch the
 * profile URL, parse the JSON-LD, emit the rating summary + the individual
 * reviews. Real data, verifiable against the live page, no metered actor, no
 * fabrication risk.
 *
 * (Zocdoc, by contrast, hard-blocks a plain fetch with HTTP 403 and would need a
 * browser+proxy — dropped for now; Google + Healthgrades cover reputation.)
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface HgReview { text: string; rating?: number; date?: string; author?: string }
export interface HgProfile { name?: string; rating?: number; reviewCount?: number; reviews: HgReview[] }

/** Fetch a Healthgrades profile URL and parse its JSON-LD into rating + reviews. */
export async function readHealthgradesProfile(url: string, timeoutMs = 20000): Promise<{ ok: boolean; profile?: HgProfile; error?: string }> {
  if (!/healthgrades\.com/i.test(url)) return { ok: false, error: "not a healthgrades url" };
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    let node: any = null;
    for (const b of blocks) {
      let j: any;
      try { j = JSON.parse(b); } catch { continue; }
      const nodes = j?.["@graph"] ? j["@graph"] : Array.isArray(j) ? j : [j];
      for (const o of nodes) if (o && o.aggregateRating) { node = o; break; }
      if (node) break;
    }
    if (!node) return { ok: false, error: "no rating structured-data on page" };
    const ar = node.aggregateRating ?? {};
    const revs = (Array.isArray(node.review) ? node.review : node.review ? [node.review] : []) as any[];
    const profile: HgProfile = {
      name: typeof node.name === "string" ? node.name : undefined,
      rating: Number.isFinite(Number(ar.ratingValue)) ? round1(Number(ar.ratingValue)) : undefined,
      reviewCount: Number.isFinite(Number(ar.reviewCount)) ? Number(ar.reviewCount) : undefined,
      reviews: revs
        .map((r): HgReview => ({ text: String(r?.reviewBody ?? "").replace(/\s+/g, " ").trim(), rating: Number(r?.reviewRating?.ratingValue) || undefined, date: typeof r?.datePublished === "string" ? r.datePublished : undefined, author: typeof r?.author?.name === "string" ? r.author.name : undefined }))
        .filter((r) => r.text.length > 0),
    };
    return { ok: true, profile };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Provider wrapper so the reader plugs into the same collection flow as Google /
 * Yelp: collectContent(urls) → fetchResults() emits a rating-summary review (which
 * report.ts parses into a reputation row + feeds the Rating ring) plus each real
 * review (feeds review-pulse + price-hint mining).
 */
export class HealthgradesProvider implements PublicContentProvider {
  readonly name = "healthgrades";
  readonly provenance = "PUBLIC_WEBSITE_HTTP" as const;
  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();

  isConfigured(): boolean { return true; } // plain public fetch — no key/actor needed

  async discoverProfiles(_i: DiscoverInput): Promise<ProfileCandidate[]> { throw new UnsupportedCapability(this.name, "discoverProfiles"); }
  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> { throw new UnsupportedCapability(this.name, "collectProfiles"); }

  /** input.urls = Healthgrades profile URL(s) → parse rating + reviews. */
  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    const jobId = `hg_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    this.jobs.set(jobId, { status: { jobId, provider: this.name, status: "running" }, results: [] });

    (async () => {
      const out: RawObservation[] = [];
      const errors: string[] = [];
      const now = new Date().toISOString();
      for (const url of input.urls) {
        const { ok, profile, error } = await readHealthgradesProfile(url);
        if (!ok || !profile) { if (error) errors.push(error); continue; }
        // 1) rating summary — the exact shape report.ts parses into a reputation row
        if (profile.rating != null) {
          const text = `Rated ${profile.rating}★ on Healthgrades from ${profile.reviewCount ?? 0} reviews.`;
          out.push({
            provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "review",
            externalRef: `${url}#rating`, sourceUrl: url, text, media: [], observedAt: now,
            contentHash: createHash("sha256").update(`${url}|${profile.rating}|${profile.reviewCount}`).digest("hex"),
            raw: { rating: profile.rating, reviewCount: profile.reviewCount, name: profile.name },
            structuredHints: { kind: "rating_summary", rating: profile.rating, review_count: profile.reviewCount },
          });
        }
        // 2) individual reviews — feed review-pulse + price-hint mining
        for (const r of profile.reviews) {
          const rid = createHash("sha256").update(`${url}|${r.text}`).digest("hex").slice(0, 16);
          out.push({
            provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "review",
            externalRef: `${url}#${rid}`, sourceUrl: url, text: r.text, media: [], publishedAt: r.date, observedAt: now,
            contentHash: createHash("sha256").update(`${rid}|${r.text}`).digest("hex"),
            raw: r, structuredHints: { rating: r.rating },
          });
        }
      }
      const job = this.jobs.get(jobId)!;
      job.results = out;
      job.status = { jobId, provider: this.name, status: out.length ? "succeeded" : errors.length ? "failed" : "partial", resultCount: out.length, error: errors.length ? errors.slice(0, 5).join("; ") : undefined };
    })();

    return { jobId, provider: this.name, status: "running", submittedAt: new Date().toISOString() };
  }

  async getJob(jobId: string): Promise<ProviderJobStatus> {
    return this.jobs.get(jobId)?.status ?? { jobId, provider: this.name, status: "failed", error: "unknown job" };
  }
  async *fetchResults(jobId: string): AsyncIterable<RawObservation> {
    for (const o of this.jobs.get(jobId)?.results ?? []) yield o;
  }
  async estimateCost(_i: ProviderRequest): Promise<CostEstimate> {
    return { provider: this.name, currency: "USD", estimatedUsd: 0, basis: "Plain HTTP fetch of the public Healthgrades profile (no metered actor)" };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return { provider: this.name, ok: true, configured: true, checkedAt: new Date().toISOString() };
  }
}
