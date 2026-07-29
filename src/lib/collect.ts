import { createServiceClient } from "@/lib/supabase/server";
import { crawlWebsite } from "@/lib/providers/website/crawler";
import { runExtraction, type PipelineOffer } from "@/lib/extraction/pipeline";
import { getProvider } from "@/lib/providers/registry";
import { generateRecommendations, type BusinessOffers } from "@/lib/recommend/engine";

/**
 * Autonomous collection worker — the guide's per-business monitoring pass
 * (§5.3 BusinessMonitoringWorkflow), bounded so one call fits a request
 * timeout. Pulls everything available for a business (website crawl + offer
 * extraction now; Google reviews/photos + social when those keys are present),
 * records a provider_run, and stamps last_collected_at.
 *
 * The client drives collection one business at a time so long crawls never
 * block a single request; a background queue is the later hardening.
 */

const MAX_PAGES = 8;

export interface CollectResult {
  businessId: string;
  name: string;
  website?: string;
  ok: boolean;
  pagesFetched: number;
  offersWritten: number;
  reviews: number;
  error?: string;
}

type Svc = ReturnType<typeof createServiceClient>;

async function insertOffers(
  svc: Svc,
  businessId: string,
  contentItemId: string,
  offers: PipelineOffer[],
  nowIso: string,
): Promise<number> {
  if (!offers.length) return 0;
  const rows = offers.map((o) => ({
    business_id: businessId,
    content_item_id: contentItemId,
    entity_text: o.entity_text,
    offer_type: o.offer_type,
    pricing: o.pricing,
    conditions: o.conditions ?? [],
    validity_start: o.validity_start,
    validity_end: o.validity_end,
    confidence: o.confidence,
    provenance: o.provenance,
    observed_at: nowIso,
    valid_from: nowIso,
  }));
  const { error } = await svc.from("offer").insert(rows);
  if (error) throw new Error(`offers insert: ${error.message}`);
  return rows.length;
}

async function upsertContentItem(
  svc: Svc,
  businessId: string,
  url: string,
  provenance: string,
  nowIso: string,
): Promise<string> {
  const { data, error } = await svc
    .from("content_item")
    .upsert(
      { business_id: businessId, platform: "website", external_ref: url, provenance, url, observed_at: nowIso },
      { onConflict: "platform,external_ref" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`content_item upsert: ${error.message}`);
  return data.id as string;
}

export async function collectBusiness(businessId: string): Promise<CollectResult> {
  const svc = createServiceClient();
  const nowIso = new Date().toISOString();

  const { data: biz, error: bErr } = await svc
    .from("business")
    .select("id,canonical_name,website,vertical,attributes")
    .eq("id", businessId)
    .single();
  if (bErr || !biz) {
    return { businessId, name: "?", ok: false, pagesFetched: 0, offersWritten: 0, reviews: 0, error: bErr?.message ?? "not found" };
  }

  const result: CollectResult = {
    businessId,
    name: biz.canonical_name,
    website: biz.website ?? undefined,
    ok: true,
    pagesFetched: 0,
    offersWritten: 0,
    reviews: 0,
  };

  // provider_run bookkeeping (guide §16.1: track real cost/counts)
  const { data: run } = await svc
    .from("provider_run")
    .insert({ provider: "website", input_hash: `${businessId}:${Date.now()}`, status: "started" })
    .select("id")
    .single();

  const errors: string[] = [];
  const collectedOffers: PipelineOffer[] = [];

  // ── website crawl + offer extraction ──────────────────────────────────
  if (biz.website) {
    try {
      const crawl = await crawlWebsite(biz.website, { maxPages: MAX_PAGES });
      result.pagesFetched = crawl.pagesFetched;
      for (const obs of crawl.observations) {
        if (!obs.sourceUrl) continue;
        try {
          const ci = await upsertContentItem(svc, businessId, obs.sourceUrl, obs.provenance, nowIso);
          const out = await runExtraction(obs, { vertical: biz.vertical ?? "restaurant", name: biz.canonical_name });
          if (out.offers.length) {
            result.offersWritten += await insertOffers(svc, businessId, ci, out.offers, nowIso);
            collectedOffers.push(...out.offers);
          }
        } catch (e) {
          errors.push(`${obs.sourceUrl}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`crawl: ${(e as Error).message}`);
    }
  } else {
    errors.push("no website on file");
  }

  // ── Google reviews (only when keyed and we have a place id) ───────────
  const placeId = (biz.attributes as any)?.place_id;
  const google = getProvider("google");
  if (placeId && google?.isConfigured()) {
    try {
      const job = await google.collectContent({ urls: [placeId] });
      // small poll
      for (let i = 0; i < 8; i++) {
        const st = await google.getJob(job.jobId);
        if (st.status === "succeeded" || st.status === "failed") break;
        await new Promise((r) => setTimeout(r, 800));
      }
      for await (const rev of google.fetchResults(job.jobId)) {
        const ci = await upsertContentItem(svc, businessId, rev.sourceUrl ?? `${placeId}#${result.reviews}`, rev.provenance, nowIso);
        await svc.from("content_item").update({ text: rev.text }).eq("id", ci);
        result.reviews++;
      }
    } catch (e) {
      errors.push(`google reviews: ${(e as Error).message}`);
    }
  }

  // stamp last_collected_at
  await svc
    .from("business")
    .update({ attributes: { ...(biz.attributes as any), last_collected_at: nowIso } })
    .eq("id", businessId);

  // finish provider_run
  if (run?.id) {
    await svc
      .from("provider_run")
      .update({
        status: errors.length && result.offersWritten === 0 ? "partial" : "succeeded",
        result_count: result.offersWritten,
        cost_usd: 0,
        finished_at: new Date().toISOString(),
        error: errors.length ? errors.slice(0, 5).join("; ") : null,
      })
      .eq("id", run.id);
  }

  if (errors.length && result.offersWritten === 0 && result.pagesFetched === 0) {
    result.ok = false;
    result.error = errors.slice(0, 3).join("; ");
  }
  return result;
}

/**
 * Recompute the workspace's recommendations from all persisted offers
 * (target vs competitors) and refresh the open 'proposed' set (guide §10).
 */
export async function refreshRecommendations(workspaceId: string): Promise<number> {
  const svc = createServiceClient();
  const { data: ws } = await svc
    .from("workspace")
    .select("id,target_business_id")
    .eq("id", workspaceId)
    .single();
  if (!ws?.target_business_id) return 0;

  const { data: edges } = await svc.from("competitor_edge").select("competitor_id").eq("workspace_id", workspaceId);
  const competitorIds = (edges ?? []).map((e: any) => e.competitor_id as string);
  const allIds = [ws.target_business_id, ...competitorIds];

  const { data: offers } = await svc
    .from("offer")
    .select("business_id,entity_text,offer_type,pricing,confidence,provenance,observed_at")
    .in("business_id", allIds)
    .order("observed_at", { ascending: false })
    .limit(1000);

  const byBiz = new Map<string, PipelineOffer[]>();
  const seen = new Map<string, Set<string>>();
  for (const o of offers ?? []) {
    const bid = o.business_id as string;
    if (!byBiz.has(bid)) {
      byBiz.set(bid, []);
      seen.set(bid, new Set());
    }
    const key = (o.entity_text as string).toLowerCase().trim();
    if (seen.get(bid)!.has(key)) continue;
    seen.get(bid)!.add(key);
    byBiz.get(bid)!.push({
      entity_text: o.entity_text,
      canonical_entity_id: null,
      offer_type: o.offer_type,
      pricing: o.pricing as any,
      conditions: [],
      validity_start: null,
      validity_end: null,
      confidence: Number(o.confidence),
      provenance: o.provenance as any,
      evidence: [],
    });
  }

  const { data: names } = await svc.from("business").select("id,canonical_name").in("id", allIds);
  const nameOf = new Map<string, string>(
    (names ?? []).map((n: any) => [n.id, n.canonical_name]),
  );

  const target: BusinessOffers = {
    businessId: ws.target_business_id,
    name: nameOf.get(ws.target_business_id) ?? "You",
    offers: byBiz.get(ws.target_business_id) ?? [],
  };
  const competitors: BusinessOffers[] = competitorIds.map((id: string) => ({
    businessId: id,
    name: nameOf.get(id) ?? "Competitor",
    offers: byBiz.get(id) ?? [],
  }));

  const recs = generateRecommendations(target, competitors);

  await svc.from("recommendation").delete().eq("workspace_id", workspaceId).eq("status", "proposed");
  if (recs.length) {
    const rows = recs.map((r) => ({
      workspace_id: workspaceId,
      category: r.category,
      title: r.title,
      action: r.action,
      why_now: r.why_now,
      expected_impact: r.expected_impact,
      effort: r.effort,
      urgency: r.urgency,
      priority: r.priority,
      status: "proposed",
    }));
    await svc.from("recommendation").insert(rows);
  }
  return recs.length;
}
