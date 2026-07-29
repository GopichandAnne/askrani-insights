"use server";

import { crawlWebsite } from "@/lib/providers/website/crawler";
import { runExtraction, type PipelineOffer } from "@/lib/extraction/pipeline";
import { isLlmConfigured } from "@/lib/extraction/llm";
import { generateRecommendations, type BusinessOffers, type Recommendation } from "@/lib/recommend/engine";

/**
 * Live onboarding analysis — the whole intelligence thread in one server action,
 * runnable before Supabase/auth exist so the value is visible day one:
 *   crawl target + competitors → extract offers → benchmark → recommend.
 *
 * When Supabase is configured, this same result is what a BusinessMonitoringWorkflow
 * (guide 5.3) persists; here we return it directly for an ephemeral preview.
 */

export interface AnalyzedBusiness {
  url: string;
  name: string;
  pagesFetched: number;
  offers: Array<{
    entity_text: string;
    offer_type: string;
    amount: number | null;
    currency: string;
    confidence: number;
    provenance: string;
    method: string;
  }>;
  warnings: string[];
}

export interface AnalysisResult {
  ok: boolean;
  error?: string;
  llmUsed: boolean;
  target: AnalyzedBusiness | null;
  competitors: AnalyzedBusiness[];
  recommendations: Recommendation[];
}

const MAX_COMPETITORS = 6;
const MAX_PAGES = 8;

async function analyzeOne(url: string, method: string): Promise<{ biz: AnalyzedBusiness; offers: PipelineOffer[] }> {
  const crawl = await crawlWebsite(url, { maxPages: MAX_PAGES });
  const name = crawl.observations.find((o) => o.businessHint?.name)?.businessHint?.name ?? hostOf(url);
  const offers: PipelineOffer[] = [];
  const warnings: string[] = [];

  for (const obs of crawl.observations) {
    try {
      const out = await runExtraction(obs, { vertical: "restaurant", name, timezone: undefined });
      offers.push(...out.offers);
      warnings.push(...out.warnings);
    } catch (e) {
      warnings.push(`extract failed on ${obs.sourceUrl}: ${(e as Error).message}`);
    }
  }

  // dedupe offers by entity text, keep highest confidence
  const byKey = new Map<string, PipelineOffer>();
  for (const o of offers) {
    const k = o.entity_text.toLowerCase().trim();
    if (!k) continue;
    const cur = byKey.get(k);
    if (!cur || o.confidence > cur.confidence) byKey.set(k, o);
  }
  const deduped = [...byKey.values()];

  return {
    biz: {
      url,
      name,
      pagesFetched: crawl.pagesFetched,
      offers: deduped.slice(0, 40).map((o) => ({
        entity_text: o.entity_text,
        offer_type: o.offer_type,
        amount: (o.pricing as any)?.amount ?? null,
        currency: (o.pricing as any)?.currency ?? "USD",
        confidence: o.confidence,
        provenance: o.provenance,
        method,
      })),
      warnings: [...new Set(warnings)].slice(0, 8),
    },
    offers: deduped,
  };
}

export async function analyzeMarket(
  _prev: AnalysisResult | null,
  formData: FormData,
): Promise<AnalysisResult> {
  const targetUrl = String(formData.get("targetUrl") ?? "").trim();
  const competitorRaw = String(formData.get("competitorUrls") ?? "");
  const competitorUrls = competitorRaw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_COMPETITORS);

  if (!targetUrl) {
    return { ok: false, error: "Enter your business website to analyze.", llmUsed: false, target: null, competitors: [], recommendations: [] };
  }

  try {
    const targetRes = await analyzeOne(targetUrl, isLlmConfigured() ? "model" : "jsonld");
    const compRes = await Promise.all(
      competitorUrls.map((u) => analyzeOne(u, isLlmConfigured() ? "model" : "jsonld").catch(() => null)),
    );
    const competitors = compRes.filter(Boolean) as { biz: AnalyzedBusiness; offers: PipelineOffer[] }[];

    const targetOffers: BusinessOffers = { businessId: "target", name: targetRes.biz.name, offers: targetRes.offers };
    const competitorOffers: BusinessOffers[] = competitors.map((c, i) => ({
      businessId: `comp_${i}`,
      name: c.biz.name,
      offers: c.offers,
    }));

    const recommendations = generateRecommendations(targetOffers, competitorOffers);

    return {
      ok: true,
      llmUsed: isLlmConfigured(),
      target: targetRes.biz,
      competitors: competitors.map((c) => c.biz),
      recommendations,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, llmUsed: isLlmConfigured(), target: null, competitors: [], recommendations: [] };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
