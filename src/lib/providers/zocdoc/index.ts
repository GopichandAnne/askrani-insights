import {
  PublicContentProvider, DiscoverInput, ProfileBatch, ContentBatch, ProviderJob,
  ProviderJobStatus, ProviderHealth, ProviderRequest, CostEstimate, ProfileCandidate,
  RawObservation, UnsupportedCapability, ProviderNotConfigured,
} from "../types";
import { createHash } from "node:crypto";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Zocdoc reader — via Bright Data Web Unlocker (Zocdoc hard-blocks a plain fetch
 * with 403/PerimeterX; the unlocker returns HTTP 200 with the real page — verified).
 * Zocdoc is the best structured source for a dental practice's ACCEPTED INSURANCE
 * (a top patient filter) plus rating, reviews, and accepting-new-patients — the
 * signals websites often omit. We unlock the practice page, then LLM-extract those
 * facts (robust to Zocdoc's markup), and emit them as normalized observations that
 * feed the Rating ring, the insurance comparison, and review mining.
 *
 * Metered: each unlock is a Bright Data request (~$2.50/1K for anti-bot domains),
 * so it only runs for a business that has a stored Zocdoc URL (owner-provided).
 * Dormant unless BRIGHTDATA_API_TOKEN + BRIGHTDATA_UNLOCKER_ZONE are set.
 */

const ZONE = () => process.env.BRIGHTDATA_UNLOCKER_ZONE ?? "web_unlocker1";
const TOKEN = () => process.env.BRIGHTDATA_API_TOKEN ?? "";

/** Unlock a URL through Bright Data Web Unlocker → raw HTML (or an error). */
export async function brightDataUnlock(url: string, timeoutMs = 60000): Promise<{ ok: boolean; html?: string; error?: string }> {
  const token = TOKEN();
  if (!token) return { ok: false, error: "BRIGHTDATA_API_TOKEN not set" };
  try {
    const res = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ zone: ZONE(), url, format: "raw" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `unlocker HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 140)}` };
    const html = await res.text();
    if (!html || html.length < 500) return { ok: false, error: "empty/blocked response" };
    return { ok: true, html };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface ZdReview { text: string; rating?: number; date?: string }
export interface ZdProfile { name?: string; rating?: number; reviewCount?: number; acceptingNewPatients?: boolean; insurances: string[]; reviews: ZdReview[] }

const EXTRACT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    name: { type: "string", description: "the practice/provider name" },
    rating: { type: "number", description: "overall star rating (0–5) if shown" },
    reviewCount: { type: "number", description: "total number of reviews if shown" },
    acceptingNewPatients: { type: "boolean", description: "true if the page says it accepts new patients" },
    insurances: { type: "array", items: { type: "string" }, description: "accepted insurance plan names exactly as listed (Delta Dental, Cigna, Aetna, MetLife, …). Empty if none shown." },
    reviews: { type: "array", maxItems: 15, items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, rating: { type: "number" }, date: { type: "string" } }, required: ["text"] }, description: "individual patient review texts (with rating/date if present)" },
  },
  required: ["insurances", "reviews"],
};
const EXTRACT_SYSTEM =
  "You extract facts from a Zocdoc dental practice page. Return ONLY what's actually present: the practice name, overall rating + review count, whether it accepts new patients, the list of accepted insurance plans (exact names), and up to 15 patient review texts (with rating/date if shown). Never invent — omit anything the page doesn't show.";

/** Unlock a Zocdoc profile URL and LLM-extract insurance + rating + reviews. */
export async function readZocdocProfile(url: string): Promise<{ ok: boolean; profile?: ZdProfile; error?: string }> {
  if (!/zocdoc\.com/i.test(url)) return { ok: false, error: "not a zocdoc url" };
  const { ok, html, error } = await brightDataUnlock(url);
  if (!ok || !html) return { ok: false, error };
  if (!isLlmConfigured()) return { ok: false, error: "no LLM configured" };
  // visible text only (drop scripts/styles/tags), capped for the model
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 16000);
  try {
    const { data } = await getLlm().callStructured<ZdProfile>({ system: EXTRACT_SYSTEM, text: `ZOCDOC PAGE TEXT:\n${text}\n\nExtract the practice facts.`, schema: EXTRACT_SCHEMA, tier: "extract", maxTokens: 1600 });
    const profile: ZdProfile = {
      name: typeof data.name === "string" ? data.name : undefined,
      rating: Number.isFinite(Number(data.rating)) && Number(data.rating) > 0 ? Math.round(Number(data.rating) * 10) / 10 : undefined,
      reviewCount: Number.isFinite(Number(data.reviewCount)) ? Number(data.reviewCount) : undefined,
      acceptingNewPatients: typeof data.acceptingNewPatients === "boolean" ? data.acceptingNewPatients : undefined,
      insurances: Array.isArray(data.insurances) ? data.insurances.map((s) => String(s).trim()).filter(Boolean).slice(0, 40) : [],
      reviews: Array.isArray(data.reviews) ? data.reviews.map((r) => ({ text: String(r?.text ?? "").trim(), rating: Number(r?.rating) || undefined, date: typeof r?.date === "string" ? r.date : undefined })).filter((r) => r.text) : [],
    };
    return { ok: true, profile };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Provider wrapper so Zocdoc plugs into the same collection flow as Healthgrades. */
export class ZocdocProvider implements PublicContentProvider {
  readonly name = "zocdoc";
  readonly provenance = "MANAGED_PUBLIC_PROVIDER_APIFY" as const; // via managed unblocker (Bright Data)
  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();

  isConfigured(): boolean { return !!TOKEN(); } // needs the Bright Data unlocker token
  private assert() { if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, "BRIGHTDATA_API_TOKEN"); }

  async discoverProfiles(_i: DiscoverInput): Promise<ProfileCandidate[]> { throw new UnsupportedCapability(this.name, "discoverProfiles"); }
  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> { throw new UnsupportedCapability(this.name, "collectProfiles"); }

  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    this.assert();
    const jobId = `zd_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    this.jobs.set(jobId, { status: { jobId, provider: this.name, status: "running" }, results: [] });
    (async () => {
      const out: RawObservation[] = [];
      const errors: string[] = [];
      const now = new Date().toISOString();
      for (const url of input.urls) {
        const { ok, profile, error } = await readZocdocProfile(url);
        if (!ok || !profile) { if (error) errors.push(error); continue; }
        // rating summary → Rating ring
        if (profile.rating != null) {
          out.push({ provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "review", externalRef: `${url}#rating`, sourceUrl: url, text: `Rated ${profile.rating}★ on Zocdoc from ${profile.reviewCount ?? 0} reviews.`, media: [], observedAt: now, contentHash: createHash("sha256").update(`${url}|${profile.rating}|${profile.reviewCount}`).digest("hex"), raw: { rating: profile.rating, reviewCount: profile.reviewCount, name: profile.name }, structuredHints: { kind: "rating_summary", rating: profile.rating, review_count: profile.reviewCount } });
        }
        // accepted insurance → a citable "profile" item (the insurance comparison reads these)
        if (profile.insurances.length) {
          out.push({ provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "profile", externalRef: `${url}#insurance`, sourceUrl: url, text: `Insurance accepted (Zocdoc): ${profile.insurances.join(", ")}.`, media: [], observedAt: now, contentHash: createHash("sha256").update(`${url}|ins|${profile.insurances.join(",")}`).digest("hex"), raw: { insurances: profile.insurances, acceptingNewPatients: profile.acceptingNewPatients }, structuredHints: { kind: "insurance_accepted", insurances: profile.insurances } });
        }
        // reviews → pulse + price-hint mining
        for (const r of profile.reviews) {
          const rid = createHash("sha256").update(`${url}|${r.text}`).digest("hex").slice(0, 16);
          out.push({ provider: this.name, provenance: this.provenance, platform: this.name, contentKind: "review", externalRef: `${url}#${rid}`, sourceUrl: url, text: r.text, media: [], publishedAt: r.date, observedAt: now, contentHash: createHash("sha256").update(`${rid}|${r.text}`).digest("hex"), raw: r, structuredHints: { rating: r.rating } });
        }
      }
      const job = this.jobs.get(jobId)!;
      job.results = out;
      job.status = { jobId, provider: this.name, status: out.length ? "succeeded" : errors.length ? "failed" : "partial", resultCount: out.length, error: errors.length ? errors.slice(0, 5).join("; ") : undefined };
    })();
    return { jobId, provider: this.name, status: "running", submittedAt: new Date().toISOString() };
  }

  async getJob(jobId: string): Promise<ProviderJobStatus> { return this.jobs.get(jobId)?.status ?? { jobId, provider: this.name, status: "failed", error: "unknown job" }; }
  async *fetchResults(jobId: string): AsyncIterable<RawObservation> { for (const o of this.jobs.get(jobId)?.results ?? []) yield o; }
  async estimateCost(_i: ProviderRequest): Promise<CostEstimate> { return { provider: this.name, currency: "USD", estimatedUsd: 0.0025, basis: "Bright Data Web Unlocker (~$2.50/1K for anti-bot domains)" }; }
  async healthCheck(): Promise<ProviderHealth> { const ok = this.isConfigured(); return { provider: this.name, ok, configured: ok, detail: ok ? undefined : "BRIGHTDATA_API_TOKEN not set", checkedAt: new Date().toISOString() }; }
}
