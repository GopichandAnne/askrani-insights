import { createServiceClient } from "@/lib/supabase/server";
import { crawlWebsite } from "@/lib/providers/website/crawler";
import { runExtraction, type PipelineOffer } from "@/lib/extraction/pipeline";
import { getProvider } from "@/lib/providers/registry";
import type { RawObservation } from "@/lib/providers/types";
import { collectApifyPlatform, platformActorConfigured, APIFY_PLATFORMS } from "@/lib/providers/apify/platforms";
import { collectLocalNews, extractCity } from "@/lib/news";
import { findSocialHandles, findDeliveryUrls, findDirectoryUrls, reverseGeoCity } from "@/lib/social-discovery";
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

// Verticals for which the healthcare review directories are worth reading. Extend
// as medical verticals land. Healthgrades = plain fetch (free). Zocdoc = via Bright
// Data Web Unlocker (403s a plain fetch); dormant unless BRIGHTDATA_API_TOKEN set,
// and only runs for a business with a stored zocdoc_url.
const DIRECTORY_VERTICALS = new Set(["dental"]);
const DIRECTORIES = ["healthgrades", "zocdoc"];

export interface CollectResult {
  businessId: string;
  name: string;
  website?: string;
  ok: boolean;
  pagesFetched: number;
  offersWritten: number;
  reviews: number;
  socialPosts: number;
  sources: string[]; // which sources actually contributed this run ("reused" = skipped as fresh)
  reused?: boolean;  // true when the scrape was skipped because the business was collected recently
  error?: string;
}

type Svc = ReturnType<typeof createServiceClient>;

/** Loose match for the delivery search fallback — a distinctive token of the
 *  business name (len ≥ 4) must appear in the returned store name, or vice
 *  versa. Prevents attaching the wrong store when searching by name. */
// Loosened delivery store↔business matcher: strip generic words, compare
// distinctive tokens (≥3 chars) with substring overlap, and accept whole-name
// containment. Higher yield (catches "Patel Bros" ↔ "Patel Brothers Grocery")
// at a small risk of a same-name store — acceptable per product decision.
const NM_STOP = new Set(["the", "and", "grocery", "market", "supermarket", "store", "foods", "food", "restaurant", "cafe", "halal", "indian", "asian", "llc", "inc", "co", "kitchen", "bakery", "boba", "tea"]);
function nameMatches(storeName: string, bizName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const a = norm(storeName), b = norm(bizName);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true; // whole-name containment
  const toks = (s: string) => s.split(" ").filter((t) => t.length >= 3 && !NM_STOP.has(t));
  const at = toks(a), bt = toks(b);
  if (!at.length || !bt.length) return false;
  // any distinctive token shared, or one contained in the other (Bros↔Brothers)
  return at.some((x) => bt.some((y) => x === y || x.includes(y) || y.includes(x)));
}

async function insertOffers(
  svc: Svc,
  businessId: string,
  contentItemId: string,
  offers: PipelineOffer[],
  nowIso: string,
): Promise<number> {
  if (!offers.length) return 0;
  // Dedup WITHIN this extraction: delivery actors and menu pages return the same
  // item many times (once per section / customization / size), so a single scrape
  // can carry 4000 rows for a 260-item menu. Collapse to one row per
  // (item, price) before writing — otherwise the offer table balloons and price
  // stats are computed over massive duplication.
  const seenKey = new Set<string>();
  const deduped = offers.filter((o) => {
    const k = `${String(o.entity_text ?? "").toLowerCase().trim()}|${(o.pricing as any)?.amount ?? ""}`;
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });
  const rows = deduped.map((o) => ({
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
  // Replace-per-source: each scan re-extracts the FULL offer set for this content
  // item (a menu page, a flyer, a delivery store), so clear this content item's
  // prior offers before inserting the fresh set. Appending instead — the old
  // behaviour — duplicated the whole menu every scan (one restaurant reached
  // 13k+ rows), which poisoned price analysis and bloated the table. Scoped to
  // (business_id, content_item_id) so other sources' offers are untouched, and
  // only runs when this extraction actually produced offers (a transient empty
  // extraction keeps the last good set rather than wiping it).
  // NB: needs the offer(content_item_id) index (migration 0073). Without it, on a
  // business with thousands of offers this delete scans the whole business
  // partition and trips the 8s statement timeout — silently deleting 0 rows and
  // letting every scan re-append the menu. We now surface that error instead of
  // ignoring it, so the failure is visible rather than becoming silent bloat.
  const { error: delErr } = await svc.from("offer").delete().eq("business_id", businessId).eq("content_item_id", contentItemId);
  if (delErr) throw new Error(`offers dedup-delete failed (add offer.content_item_id index): ${delErr.message}`);
  const { error } = await svc.from("offer").insert(rows);
  if (error) throw new Error(`offers insert: ${error.message}`);
  return rows.length;
}

/** Stable content_item ref from a URL: lowercased host, no trailing slash, no
 *  fragment — so the same page never spawns a fresh content_item (orphaning the
 *  old one's offers) just because a scan saw "site.com" vs "site.com/". */
function normalizeRef(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u;
  }
}

/** Upsert a content_item from any RawObservation (website page, review, post). */
/** Normalize a provider-supplied timestamp to ISO, or null. Handles Unix epoch
 *  seconds/ms (the Facebook posts actor returns e.g. 1779025419 seconds, which as
 *  a raw value blows up the timestamptz column — "out of range"), numeric strings,
 *  ISO/loose date strings, and empty/garbage → null. Central so every provider's
 *  dates land safely instead of silently dropping the whole content item. */
function toIsoOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,14}$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n < 1e12 ? n * 1000 : n); // < 1e12 → seconds, else milliseconds
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function upsertObsContentItem(
  svc: Svc,
  businessId: string,
  obs: RawObservation,
  nowIso: string,
): Promise<string> {
  const externalRef = obs.externalRef ?? (obs.sourceUrl ? normalizeRef(obs.sourceUrl) : `${obs.platform}:${obs.contentHash}`);
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
        published_at: toIsoOrNull(obs.publishedAt),
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
async function finishRun(svc: Svc, runId: string | undefined, count: number, error?: string, costUsd = 0) {
  if (!runId) return;
  await svc
    .from("provider_run")
    .update({
      status: error && count === 0 ? "partial" : "succeeded",
      result_count: count,
      cost_usd: Number(costUsd.toFixed(4)),
      finished_at: new Date().toISOString(),
      error: error ?? null,
    })
    .eq("id", runId);
}

// Per-request cost estimates for metered sources (guide §16.1; Apify uses the
// Actor's real usageTotalUsd, these are best-effort estimates for the rest).
const GOOGLE_CALL_USD = 0.017; // Places API (New) SKU, approx
const AI_PER_ITEM_USD = 0.004; // rough Claude cost per extracted content item

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

// A business's collected data is shared across EVERY workspace that watches it
// (content_items/offers are keyed by business, not workspace), so a business
// scraped within this window is reused rather than re-scraped for another
// workspace — big cost saver. A manual/on-demand refresh (force) or a scoped
// single-source refresh (only) always bypasses it.
const COLLECT_FRESH_MS = 6 * 60 * 60 * 1000;

export async function collectBusiness(
  businessId: string,
  opts: { budgetMs?: number; only?: string[]; force?: boolean } = {},
): Promise<CollectResult> {
  const svc = createServiceClient();
  const nowIso = new Date().toISOString();
  // Time-box the whole pass so a many-source business never exceeds the
  // function limit (~300s). Slow sources beyond the budget are skipped this
  // run and picked up on the next scan. `only` restricts to named sources.
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 250_000;
  const wants = (s: string) => !opts.only || opts.only.includes(s);
  const hasTime = () => Date.now() - started < budgetMs;

  const { data: biz, error: bErr } = await svc
    .from("business")
    .select("id,canonical_name,website,vertical,attributes")
    .eq("id", businessId)
    .single();
  if (bErr || !biz) {
    return { businessId, name: "?", ok: false, pagesFetched: 0, offersWritten: 0, reviews: 0, socialPosts: 0, sources: [], error: bErr?.message ?? "not found" };
  }
  const vertical = biz.vertical ?? "restaurant";
  // Delivery apps (DoorDash/UberEats) only make sense for food. Med spas, salons
  // etc. are never on them, so we skip all delivery discovery + Apify scraping for
  // non-food verticals — that's wasted Apify compute/proxy spend otherwise.
  const foodVertical = vertical === "restaurant" || vertical === "grocery";
  // Healthcare/local-services directories (Healthgrades, Zocdoc) only make sense
  // for health verticals — that's where their reputation + accepted insurance
  // live. A restaurant has no Healthgrades profile, so never spend a scrape there.
  const directoryVertical = DIRECTORY_VERTICALS.has(vertical);
  const attrs = (biz.attributes as any) ?? {};
  const geo = attrs.geo as { lat: number; lng: number } | undefined;

  // Freshness reuse: skip re-scraping a business collected recently (its data is
  // already shared by every workspace watching it). `force` / `only` bypass it.
  if (!opts.force && !opts.only && attrs.last_collected_at) {
    const ageMs = Date.now() - new Date(attrs.last_collected_at as string).getTime();
    if (ageMs >= 0 && ageMs < COLLECT_FRESH_MS) {
      return {
        businessId, name: biz.canonical_name, website: biz.website ?? undefined,
        ok: true, pagesFetched: 0, offersWritten: 0, reviews: 0, socialPosts: 0,
        sources: ["reused"], reused: true,
      };
    }
  }

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
  let aiItems = 0; // count of content items sent through Claude extraction (for AI cost)

  // ── 0) RESOLVE WEB PRESENCE ─────────────────────────────────────────────
  // Competitors often have no website on file (OSM is sparse), so their site is
  // never crawled and their social handles are never found — meaning rivals'
  // social posts never get collected. Google Places knows their website, so when
  // we have none, borrow Google's and persist it. The crawl below then mines it
  // for Instagram/Facebook/TikTok/YouTube links. (No extra Google cost: the
  // place_id we resolve here lets the Google review step skip its own lookup.)
  if (!biz.website && !attrs.web_resolved && wants("website") && hasTime()) {
    const g = getProvider("google");
    if (g?.isConfigured()) {
      try {
        const cands = await g.discoverProfiles({ query: biz.canonical_name, near: geo, limit: 1 });
        const cand = cands[0];
        // Don't claim a place_id another business already owns — that's how a
        // DoorDash/Clover ghost listing ends up mapped to the real store's place.
        if (cand?.externalId && !attrs.place_id) {
          const { data: owner } = await svc.from("business").select("id").filter("attributes->>place_id", "eq", cand.externalId).neq("id", businessId).limit(1).maybeSingle();
          if (!owner) attrs.place_id = cand.externalId;
        }
        if (cand?.website) {
          try { biz.website = new URL(cand.website).origin; } catch { biz.website = cand.website; }
          await svc.from("business").update({ website: biz.website }).eq("id", businessId);
        }
        attrs.web_resolved = true; // don't re-query Google for this every run
        attrsDirty = true;
      } catch {
        /* leave web_resolved unset so we retry next run */
      }
    }
  }

  // ── 1) WEBSITE (always) ─────────────────────────────────────────────────
  if (biz.website && wants("website")) {
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
          aiItems++;
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
      // A link on the business's OWN website is the strongest possible signal that
      // the handle is really theirs — mark it auto_verified, not just observed.
      await svc
        .from("external_identity")
        .insert({ business_id: businessId, platform: pl.platform, url: pl.url, verification_state: "auto_verified" })
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

  // ── social handle discovery by name: many businesses (esp. ethnic grocers)
  //    only exist on social and don't link it from their site — find the handle
  //    via web search so competitors' IG/FB get scanned too. Same run scrapes it.
  if (!attrs.social_resolved && hasTime() && platformActorConfigured("instagram")) {
    const haveIg = (identRows ?? []).some((i: any) => i.platform === "instagram");
    const haveFb = (identRows ?? []).some((i: any) => i.platform === "facebook");
    const haveTt = (identRows ?? []).some((i: any) => i.platform === "tiktok");
    if (!haveIg || !haveFb || !haveTt) {
      // Geo-guard: require a city/geo signal before accepting a name-matched
      // social handle, so a generic-named competitor can't grab a same-name
      // account in another city. City from the address, else reverse-geocoded.
      let socialCity = extractCity(attrs.address as string | undefined);
      if (!socialCity && geo) socialCity = await reverseGeoCity(geo);
      if (!socialCity) {
        attrs.social_resolved = true; // no location signal → skip name discovery
        attrsDirty = true;
      } else try {
        const found = await findSocialHandles(
          biz.canonical_name, socialCity,
          { instagram: !haveIg, facebook: !haveFb, tiktok: !haveTt },
          { website: biz.website ?? undefined, city: socialCity },
        );
        for (const [platform, url] of Object.entries(found)) {
          if (platform === "searched" || platform === "confidence" || !url || typeof url !== "string") continue;
          // Backlink-verified handles are trusted; name+geo matches are attached as
          // "observed" so the owner confirms them in the profiles step.
          const conf = found.confidence?.[platform as "instagram" | "facebook" | "tiktok"];
          await svc
            .from("external_identity")
            .insert({ business_id: businessId, platform, url, verification_state: conf === "high" ? "auto_verified" : "observed" })
            .then(() => {}, () => {});
          (identRows ?? []).push({ platform, url, handle: null } as any);
        }
        // Only mark resolved once the search actually responded; a blocked/empty
        // search leaves the flag off so a later run retries (self-healing).
        if (found.searched) { attrs.social_resolved = true; attrsDirty = true; }
      } catch {
        /* best-effort — retry next run */
      }
    }
  }

  // ── 1b) INTELLIGENT DELIVERY URL discovery — search the business by name+city
  //    and let the LLM pick its DoorDash/UberEats store page, then attach it so
  //    the delivery actor pulls the full priced menu (search-by-name is flaky). ─
  if (foodVertical && !attrs.delivery_resolved && hasTime() && (platformActorConfigured("doordash") || platformActorConfigured("ubereats"))) {
    const haveDd = (identRows ?? []).some((i: any) => i.platform === "doordash");
    const haveUe = (identRows ?? []).some((i: any) => i.platform === "ubereats");
    const wantDd = !haveDd && platformActorConfigured("doordash");
    const wantUe = !haveUe && platformActorConfigured("ubereats");
    if (wantDd || wantUe) {
      let city = extractCity(attrs.address as string | undefined);
      if (!city && geo) city = await reverseGeoCity(geo);
      if (city) {
        try {
          const dfound = await findDeliveryUrls(biz.canonical_name, city, { doordash: wantDd, ubereats: wantUe });
          for (const [platform, url] of Object.entries(dfound)) {
            if (platform === "searched" || !url || typeof url !== "string") continue;
            await svc.from("external_identity").insert({ business_id: businessId, platform, url, verification_state: "observed" }).then(() => {}, () => {});
            (identRows ?? []).push({ platform, url, handle: null } as any);
          }
          if (dfound.searched) { attrs.delivery_resolved = true; attrsDirty = true; }
        } catch {
          /* best-effort — retry next run */
        }
      }
    }
  }

  // ── 1c) INTELLIGENT DIRECTORY URL discovery (dental) — the practice's Zocdoc /
  //    Healthgrades profile URL, so the directory readers auto-target it without
  //    the owner pasting anything. Website links are already captured above (as
  //    auto_verified); this fills in via name+city search for practices that don't
  //    link their profile. Runs for the target AND every competitor we collect.
  if (directoryVertical && !attrs.directory_resolved && hasTime()) {
    const haveHg = (identRows ?? []).some((i: any) => i.platform === "healthgrades");
    const haveZd = (identRows ?? []).some((i: any) => i.platform === "zocdoc");
    if (!haveHg || !haveZd) {
      let city = extractCity(attrs.address as string | undefined);
      if (!city && geo) city = await reverseGeoCity(geo);
      if (city) {
        try {
          const dirs = await findDirectoryUrls(biz.canonical_name, city, { healthgrades: !haveHg, zocdoc: !haveZd });
          for (const [platform, url] of Object.entries(dirs)) {
            if (platform === "searched" || !url || typeof url !== "string") continue;
            await svc.from("external_identity").insert({ business_id: businessId, platform, url, verification_state: "observed" }).then(() => {}, () => {});
            (identRows ?? []).push({ platform, url, handle: null } as any);
          }
          if (dirs.searched) { attrs.directory_resolved = true; attrsDirty = true; }
        } catch {
          /* best-effort — retry next run */
        }
      }
    }
  }

  // ── 2) GOOGLE reviews (resolve+store place_id first) ─────────────────────
  const google = getProvider("google");
  if (google?.isConfigured() && wants("google") && hasTime()) {
    const run = await startRun(svc, "google", businessId);
    let n = 0;
    let gCalls = 0; // billable Places API calls this run
    try {
      let placeId = attrs.place_id as string | undefined;
      if (!placeId) {
        const cands = await google.discoverProfiles({ query: `${biz.canonical_name}`, near: geo, limit: 1 });
        gCalls++; // Text Search
        placeId = cands[0]?.externalId;
        if (placeId) {
          const { data: owner } = await svc.from("business").select("id").filter("attributes->>place_id", "eq", placeId).neq("id", businessId).limit(1).maybeSingle();
          if (owner) placeId = undefined; // another business owns this place — skip
        }
        if (placeId) {
          attrs.place_id = placeId;
          attrsDirty = true;
        }
      }
      if (placeId) {
        const job = await google.collectContent({ urls: [placeId] });
        gCalls++; // Place Details (reviews + photos)
        await pollJob(google, job.jobId, 30000);
        for await (const rev of google.fetchResults(job.jobId)) {
          // Backfill the street address from Google (unlocks delivery search,
          // which needs an address). Same details call — no extra API cost.
          const addr = (rev.businessHint as any)?.address as string | undefined;
          if (addr && !attrs.address) { attrs.address = addr; attrsDirty = true; }
          // Google's Gemini full-corpus review summary — refresh it each run so
          // reputation/demand pillars always fuse in the latest whole-review read.
          const rs = (rev.businessHint as any)?.reviewSummary as { text?: string; disclosure?: string; reviewsUri?: string } | undefined;
          if (rs?.text) { attrs.googleReviewSummary = { ...rs, at: nowIso }; attrsDirty = true; }
          await upsertObsContentItem(svc, businessId, rev, nowIso);
          n++;
        }
        if (n > 0) result.sources.push("google");
      }
    } catch (e) {
      errors.push(`google: ${(e as Error).message}`);
    }
    result.reviews += n;
    await finishRun(svc, run, n, undefined, gCalls * GOOGLE_CALL_USD);
  }

  // ── 3) YELP reviews (resolve+store yelp id first) ────────────────────────
  const yelp = getProvider("yelp");
  if (yelp?.isConfigured() && wants("yelp") && hasTime()) {
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

  // ── 3.5) HEALTHCARE DIRECTORIES (Healthgrades, Zocdoc) — reputation +
  //    accepted insurance for dental/medical. Each emits a per-source rating
  //    summary (feeds the Rating ring alongside Google/Yelp), the accepted-
  //    insurance list (a citable "do they take my plan?" source), and review
  //    text (review-pulse / rival-gripe mining). The profile URL is AUTO-DISCOVERED
  //    (website link or name+city search, above) — the owner never sets it.
  //    Healthgrades = free fetch; Zocdoc = Bright Data (dormant w/o token). ──────
  if (directoryVertical) {
    for (const dir of DIRECTORIES) {
      const prov = getProvider(dir);
      if (!prov?.isConfigured() || !wants(dir) || !hasTime()) continue;
      const run = await startRun(svc, dir, businessId);
      let n = 0, costUsd = 0;
      let dirErr: string | undefined;
      try {
        // auto-discovered profile URL (external_identity: website link or search),
        // falling back to a manually-attached attrs.<dir>_url if present.
        const profileUrl = identityUrl(dir) ?? (attrs[`${dir}_url`] as string | undefined);
        if (profileUrl) {
          const job = await prov.collectContent({ urls: [profileUrl] });
          await pollJob(prov, job.jobId, 95000);
          for await (const rev of prov.fetchResults(job.jobId)) { await upsertObsContentItem(svc, businessId, rev, nowIso); n++; }
          const st = await prov.getJob(job.jobId);
          costUsd = st.costUsd ?? 0;
          dirErr = st.error;
          if (n > 0) result.sources.push(dir);
        }
      } catch (e) {
        dirErr = (e as Error).message;
        errors.push(`${dir}: ${dirErr}`);
      }
      result.reviews += n;
      await finishRun(svc, run, n, dirErr, costUsd);
    }
  }

  // ── 4) YOUTUBE (official API): recent uploads → content + extraction ─────
  const youtube = getProvider("youtube");
  const ytUrl = identityUrl("youtube");
  if (youtube?.isConfigured() && ytUrl && wants("youtube") && hasTime()) {
    const run = await startRun(svc, "youtube", businessId);
    let n = 0;
    try {
      const job = await youtube.collectContent({ urls: [ytUrl], resultsLimit: 12 });
      await pollJob(youtube, job.jobId, 25000);
      for await (const vid of youtube.fetchResults(job.jobId)) {
        const ci = await upsertObsContentItem(svc, businessId, vid, nowIso);
        try {
          const out = await runExtraction(vid, { vertical, name: biz.canonical_name });
          aiItems++;
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
  //    Social needs a linked handle. Delivery uses the linked store URL if the
  //    business publishes one, else falls back to searching by name + address.
  //    Against those platforms' ToS — user-gated by keys.
  const DELIVERY = new Set(["doordash", "ubereats"]);
  for (const platform of APIFY_PLATFORMS) {
    if (!platformActorConfigured(platform) || !wants(platform)) continue;
    if (!hasTime()) break; // out of time budget — remaining sources next scan
    const isDelivery = DELIVERY.has(platform);
    if (isDelivery && !foodVertical) continue; // no delivery apps for non-food verticals
    const url = identityUrl(platform);

    let target = url ?? "";
    let searchQuery: string | undefined;
    if (!url) {
      // DoorDash blind search is cheap (~$0.0001) so keep it as a fallback; UberEats
      // costs ~$0.008/run and returns nothing on blind name search, so require a URL
      // (discovered in step 1b or attached in Channels) — no blind UberEats spend.
      if (platform === "doordash" && attrs.address) searchQuery = biz.canonical_name;
      else continue; // ubereats w/o URL, or social w/o handle → skip
    }

    const run = await startRun(svc, `apify:${platform}`, businessId);
    let posts = 0;
    let offers = 0;
    let apifyCost = 0;
    let apifyRunErr: string | undefined;
    try {
      const res = await collectApifyPlatform(platform, target, { maxMs: 150000, address: attrs.address, searchQuery });
      apifyCost = res.costUsd;
      if (res.error) errors.push(`apify:${platform}: ${res.error}`);
      for (const post of res.items) {
        // guard the search fallback: don't attach a store that isn't this business
        if (isDelivery && searchQuery) {
          const storeName = (post.structuredHints as any)?.jsonld?.businessName ?? "";
          if (!nameMatches(storeName, biz.canonical_name)) continue;
        }
        const ci = await upsertObsContentItem(svc, businessId, post, nowIso);
        posts++;
        try {
          const out = await runExtraction(post, { vertical, name: biz.canonical_name });
          aiItems++;
          offers += await insertOffers(svc, businessId, ci, out.offers, nowIso);
        } catch {
          /* extraction best-effort */
        }
      }
      if (posts > 0) result.sources.push(platform);
      apifyRunErr = res.error;
    } catch (e) {
      apifyRunErr = (e as Error).message;
      errors.push(`apify:${platform}: ${apifyRunErr}`);
    }
    result.socialPosts += posts;
    result.offersWritten += offers;
    await finishRun(svc, run, posts + offers, apifyRunErr, apifyCost);
  }

  // ── 6) LOCAL MARKET RADAR (target only): industry trends, local news, nearby
  //    openings via Google News RSS (free). One per workspace target is enough. ─
  if (wants("news") && hasTime()) {
    const { data: asTarget } = await svc
      .from("workspace")
      .select("id")
      .eq("target_business_id", businessId)
      .limit(1)
      .maybeSingle();
    if (asTarget) {
      const run = await startRun(svc, "news", businessId);
      let n = 0;
      try {
        const items = await collectLocalNews({
          vertical: vertical as string,
          subtype: (attrs.subtype as string[]) ?? [],
          address: attrs.address as string | undefined,
        });
        for (const it of items) {
          const { error } = await svc.from("content_item").upsert(
            {
              business_id: businessId,
              platform: "news",
              external_ref: it.url,
              provenance: "OFFICIAL_PUBLIC_API",
              url: it.url,
              text: it.title,
              media: [{ type: "news", kind: it.kind, source: it.source, excerpt: it.excerpt || undefined }],
              published_at: toIsoOrNull(it.publishedAt),
              observed_at: nowIso,
            },
            { onConflict: "platform,external_ref" },
          );
          if (!error) n++;
        }
        if (n > 0) result.sources.push("news");
      } catch (e) {
        errors.push(`news: ${(e as Error).message}`);
      }
      await finishRun(svc, run, n);
    }
  }

  // ── AI extraction cost (Claude): one estimated run for all items this pass ──
  if (aiItems > 0) {
    const aiRun = await startRun(svc, "ai", businessId);
    await finishRun(svc, aiRun, aiItems, undefined, aiItems * AI_PER_ITEM_USD);
  }

  // ── Auto-prune stale offers: for each OFFER-bearing platform that refreshed
  //    this pass, drop offers whose content_item wasn't re-observed. The
  //    per-content-item replace only ever touches what it re-scraped, so if a
  //    page/store's ref changes (or the page goes away) its old content_item —
  //    and its offers — would linger forever. Because offer→content_item is ON
  //    DELETE SET NULL, we delete the stale OFFERS first, then the empty shells.
  //    Gated on the platform being in result.sources so a skipped/failed source
  //    is never mistaken for "gone". Fast thanks to the offer.content_item_id
  //    index (0073). This is what keeps dedup automatic — no manual cleanup.
  for (const platform of ["website", "doordash", "ubereats"] as const) {
    if (!result.sources.includes(platform)) continue;
    const { data: stale } = await svc
      .from("content_item")
      .select("id")
      .eq("business_id", businessId)
      .eq("platform", platform)
      .lt("observed_at", nowIso);
    const staleIds = (stale ?? []).map((r: any) => r.id as string);
    if (staleIds.length) {
      await svc.from("offer").delete().in("content_item_id", staleIds);
      await svc.from("content_item").delete().in("id", staleIds);
    }
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

  // latest observed rating per business (from the Yelp/Google rating-summary
  // content items) so the engine's reputation rule can compare peers.
  const ratingOf = new Map<string, { rating: number; reviewCount: number | null }>();
  const { data: revs } = await svc
    .from("content_item")
    .select("business_id,text,observed_at")
    .in("business_id", allIds)
    .in("platform", ["yelp", "google"])
    .order("observed_at", { ascending: false })
    .limit(2000);
  const ratingRe = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;
  for (const rv of revs ?? []) {
    const bid = (rv as any).business_id as string;
    const m = ratingRe.exec(String((rv as any).text ?? ""));
    if (!m) continue;
    const rating = Number(m[1]);
    const reviewCount = Number(m[2].replace(/,/g, ""));
    const prev = ratingOf.get(bid);
    // keep the most-reviewed source's rating as the representative one
    if (!prev || (reviewCount ?? 0) > (prev.reviewCount ?? 0)) ratingOf.set(bid, { rating, reviewCount });
  }

  const target: BusinessOffers = {
    businessId: ws.target_business_id,
    name: nameOf.get(ws.target_business_id) ?? "You",
    offers: byBiz.get(ws.target_business_id) ?? [],
    rating: ratingOf.get(ws.target_business_id)?.rating ?? null,
    reviewCount: ratingOf.get(ws.target_business_id)?.reviewCount ?? null,
  };
  const competitors: BusinessOffers[] = competitorIds.map((id: string) => ({
    businessId: id,
    name: nameOf.get(id) ?? "Competitor",
    offers: byBiz.get(id) ?? [],
    rating: ratingOf.get(id)?.rating ?? null,
    reviewCount: ratingOf.get(id)?.reviewCount ?? null,
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
