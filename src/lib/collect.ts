import { createServiceClient } from "@/lib/supabase/server";
import { crawlWebsite } from "@/lib/providers/website/crawler";
import { runExtraction, type PipelineOffer } from "@/lib/extraction/pipeline";
import { getProvider } from "@/lib/providers/registry";
import type { RawObservation } from "@/lib/providers/types";
import { collectApifyPlatform, platformActorConfigured, APIFY_PLATFORMS } from "@/lib/providers/apify/platforms";
import { generateRecommendations, type BusinessOffers } from "@/lib/recommend/engine";

/**
 * Autonomous collection worker — the guide's per-business monitoring pass
 * (§5.3). For one business it fans out across every *applicable, configured*
 * source, recording a provider_run per source:
 *   • website crawl + offer extraction   (always; free)
 *   • Google reviews/photos              (when GOOGLE_MAPS_API_KEY set)
 *   • Yelp reviews                       (when YELP_API_KEY set)
 *   • social posts via Apify + extraction (when APIFY_TOKEN set and a handle exists)
 * Each source is guarded and bounded so one job fits a request timeout, and each
 * stays dormant until its key is present (website-only otherwise).
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
  socialPosts: number;
  sources: string[]; // which sources actually contributed this run
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

/** Upsert a content_item from any RawObservation (website page, review, post). */
async function upsertObsContentItem(
  svc: Svc,
  businessId: string,
  obs: RawObservation,
  nowIso: string,
): Promise<string> {
  const externalRef = obs.externalRef ?? obs.sourceUrl ?? `${obs.platform}:${obs.contentHash}`;
  const { data, error } = await svc
    .from("content_item")
    .upsert(
      {
        business_id: businessId,
        platform: obs.platform,
        external_ref: externalRef,
        provenance: obs.provenance,
        url: obs.sourceUrl,
        text: obs.text ?? null,
        media: obs.media ?? [],
        published_at: obs.publishedAt ?? null,
        observed_at: nowIso,
      },
      { onConflict: "platform,external_ref" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`content_item upsert: ${error.message}`);
  return data.id as string;
}

async function startRun(svc: Svc, provider: string, businessId: string): Promise<string | undefined> {
  const { data } = await svc
    .from("provider_run")
    .insert({ provider, input_hash: `${businessId}:${provider}:${Date.now()}`, status: "started" })
    .select("id")
    .single();
  return data?.id as string | undefined;
}
async function finishRun(svc: Svc, runId: string | undefined, count: number, error?: string) {
  if (!runId) return;
  await svc
    .from("provider_run")
    .update({
      status: error && count === 0 ? "partial" : "succeeded",
      result_count: count,
      cost_usd: 0,
      finished_at: new Date().toISOString(),
      error: error ?? null,
    })
    .eq("id", runId);
}

/** Bounded poll of a provider job to a terminal state. */
async function pollJob(provider: any, jobId: string, maxMs: number) {
  const deadline = Date.now() + maxMs;
  // Date.now() is fine here (regular server code, not a workflow script)
  while (Date.now() < deadline) {
    const st = await provider.getJob(jobId);
    if (st.status === "succeeded" || st.status === "failed") return st;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return provider.getJob(jobId);
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
    return { businessId, name: "?", ok: false, pagesFetched: 0, offersWritten: 0, reviews: 0, socialPosts: 0, sources: [], error: bErr?.message ?? "not found" };
  }
  const vertical = biz.vertical ?? "restaurant";
  const attrs = (biz.attributes as any) ?? {};
  const geo = attrs.geo as { lat: number; lng: number } | undefined;

  const result: CollectResult = {
    businessId,
    name: biz.canonical_name,
    website: biz.website ?? undefined,
    ok: true,
    pagesFetched: 0,
    offersWritten: 0,
    reviews: 0,
    socialPosts: 0,
    sources: [],
  };
  const errors: string[] = [];
  let attrsDirty = false;
  let profileLinks: { platform: string; url: string }[] = [];

  // ── 1) WEBSITE (always) ─────────────────────────────────────────────────
  if (biz.website) {
    const run = await startRun(svc, "website", businessId);
    let n = 0;
    try {
      const crawl = await crawlWebsite(biz.website, { maxPages: MAX_PAGES });
      result.pagesFetched = crawl.pagesFetched;
      profileLinks = crawl.profileLinks;
      for (const obs of crawl.observations) {
        if (!obs.sourceUrl) continue;
        try {
          const ci = await upsertObsContentItem(svc, businessId, obs, nowIso);
          const out = await runExtraction(obs, { vertical, name: biz.canonical_name });
          n += await insertOffers(svc, businessId, ci, out.offers, nowIso);
        } catch (e) {
          errors.push(`website ${obs.sourceUrl}: ${(e as Error).message}`);
        }
      }
      if (n > 0 || crawl.pagesFetched > 0) result.sources.push("website");
    } catch (e) {
      errors.push(`website: ${(e as Error).message}`);
    }
    result.offersWritten += n;
    await finishRun(svc, run, n);
  } else {
    errors.push("no website on file");
  }

  // ── profile resolver: persist any platform profiles the site linked to, so
  //    the social/YouTube/delivery collectors below auto-target them ─────────
  for (const pl of profileLinks) {
    const { data: exists } = await svc
      .from("external_identity")
      .select("id")
      .eq("business_id", businessId)
      .eq("platform", pl.platform)
      .limit(1)
      .maybeSingle();
    if (!exists) {
      await svc
        .from("external_identity")
        .insert({ business_id: businessId, platform: pl.platform, url: pl.url, verification_state: "observed" })
        .then(() => {}, () => {});
    }
  }

  // load all known identities for this business (from OSM discovery + resolver)
  const { data: identRows } = await svc
    .from("external_identity")
    .select("platform,url,handle")
    .eq("business_id", businessId);
  const identityUrl = (platform: string): string | undefined => {
    const row = (identRows ?? []).find((i: any) => i.platform === platform);
    return row?.url ?? (row?.handle ? row.handle : undefined);
  };

  // ── 2) GOOGLE reviews (resolve+store place_id first) ─────────────────────
  const google = getProvider("google");
  if (google?.isConfigured()) {
    const run = await startRun(svc, "google", businessId);
    let n = 0;
    try {
      let placeId = attrs.place_id as string | undefined;
      if (!placeId) {
        const cands = await google.discoverProfiles({ query: `${biz.canonical_name}`, near: geo, limit: 1 });
        placeId = cands[0]?.externalId;
        if (placeId) {
          attrs.place_id = placeId;
          attrsDirty = true;
        }
      }
      if (placeId) {
        const job = await google.collectContent({ urls: [placeId] });
        await pollJob(google, job.jobId, 30000);
        for await (const rev of google.fetchResults(job.jobId)) {
          await upsertObsContentItem(svc, businessId, rev, nowIso);
          n++;
        }
        if (n > 0) result.sources.push("google");
      }
    } catch (e) {
      errors.push(`google: ${(e as Error).message}`);
    }
    result.reviews += n;
    await finishRun(svc, run, n);
  }

  // ── 3) YELP reviews (resolve+store yelp id first) ────────────────────────
  const yelp = getProvider("yelp");
  if (yelp?.isConfigured()) {
    const run = await startRun(svc, "yelp", businessId);
    let n = 0;
    try {
      let yelpId = attrs.yelp_id as string | undefined;
      if (!yelpId) {
        const cands = await yelp.discoverProfiles({ query: biz.canonical_name, near: geo, limit: 1 });
        yelpId = cands[0]?.externalId;
        if (yelpId) {
          attrs.yelp_id = yelpId;
          attrsDirty = true;
        }
      }
      if (yelpId) {
        const job = await yelp.collectContent({ urls: [yelpId] });
        await pollJob(yelp, job.jobId, 20000);
        for await (const rev of yelp.fetchResults(job.jobId)) {
          await upsertObsContentItem(svc, businessId, rev, nowIso);
          n++;
        }
        if (n > 0) result.sources.push("yelp");
      }
    } catch (e) {
      errors.push(`yelp: ${(e as Error).message}`);
    }
    result.reviews += n;
    await finishRun(svc, run, n);
  }

  // ── 4) YOUTUBE (official API): recent uploads → content + extraction ─────
  const youtube = getProvider("youtube");
  const ytUrl = identityUrl("youtube");
  if (youtube?.isConfigured() && ytUrl) {
    const run = await startRun(svc, "youtube", businessId);
    let n = 0;
    try {
      const job = await youtube.collectContent({ urls: [ytUrl], resultsLimit: 12 });
      await pollJob(youtube, job.jobId, 25000);
      for await (const vid of youtube.fetchResults(job.jobId)) {
        const ci = await upsertObsContentItem(svc, businessId, vid, nowIso);
        try {
          const out = await runExtraction(vid, { vertical, name: biz.canonical_name });
          result.offersWritten += await insertOffers(svc, businessId, ci, out.offers, nowIso);
        } catch {
          /* best-effort */
        }
        n++;
      }
      if (n > 0) result.sources.push("youtube");
    } catch (e) {
      errors.push(`youtube: ${(e as Error).message}`);
    }
    await finishRun(svc, run, n);
  }

  // ── 5) SOCIAL + DELIVERY via Apify (dormant unless APIFY_TOKEN + Actor) ──
  //    Iterates every platform we have a link for; offer extraction runs on
  //    captions/menus. Against those platforms' ToS — user-gated by keys.
  for (const platform of APIFY_PLATFORMS) {
    const url = identityUrl(platform);
    if (!url || !platformActorConfigured(platform)) continue;
    const run = await startRun(svc, `apify:${platform}`, businessId);
    let posts = 0;
    let offers = 0;
    try {
      const items = await collectApifyPlatform(platform, url, { maxMs: 75000 });
      for (const post of items) {
        const ci = await upsertObsContentItem(svc, businessId, post, nowIso);
        posts++;
        try {
          const out = await runExtraction(post, { vertical, name: biz.canonical_name });
          offers += await insertOffers(svc, businessId, ci, out.offers, nowIso);
        } catch {
          /* extraction best-effort */
        }
      }
      if (posts > 0) result.sources.push(platform);
    } catch (e) {
      errors.push(`apify:${platform}: ${(e as Error).message}`);
    }
    result.socialPosts += posts;
    result.offersWritten += offers;
    await finishRun(svc, run, posts + offers);
  }

  // stamp last_collected_at (+ any resolved ids)
  await svc
    .from("business")
    .update({ attributes: { ...attrs, last_collected_at: nowIso } })
    .eq("id", businessId);
  void attrsDirty;

  const produced = result.pagesFetched + result.offersWritten + result.reviews + result.socialPosts;
  if (produced === 0 && errors.length) {
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
    .select("id,target_business_id,vertical")
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
  const nameOf = new Map<string, string>((names ?? []).map((n: any) => [n.id, n.canonical_name]));

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

  const recs = generateRecommendations(target, competitors, ws.vertical ?? "restaurant");

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
