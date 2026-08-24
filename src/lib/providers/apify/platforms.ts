import { createHash } from "node:crypto";
import type { RawObservation, Provenance, ContentKind } from "../types";

/**
 * Generalized Apify collection across platforms (guide 3.2: "one task per
 * provider configuration"). Each platform maps to a configurable Actor id + an
 * input builder + a result mapper. Everything here is DORMANT unless APIFY_TOKEN
 * (and, for delivery, a platform Actor id) is set — and scraping social/delivery
 * platforms is against their ToS, so activation is a deliberate, user-owned
 * decision (see docs). No detection-evasion is implemented.
 *
 * Actor ids are env-overridable because community Actors change; defaults are
 * best-known-good starting points to be verified per the guide's Actor registry.
 */

interface DeliveryCtx {
  address?: string;
  searchQuery?: string;
}
interface PlatformConfig {
  actor: () => string | undefined; // undefined = not configured → skip
  input: (target: string, ctx?: DeliveryCtx) => Record<string, unknown>;
  provenance: Provenance;
  contentKind: ContentKind;
  platform: string;
}

const env = (k: string) => process.env[k];
const handleOf = (url: string) => {
  const m = url.match(/@?([A-Za-z0-9._-]+)\/?$/);
  return m ? m[1].replace(/^@/, "") : url;
};

const CONFIG: Record<string, PlatformConfig> = {
  instagram: {
    actor: () => env("APIFY_INSTAGRAM_ACTOR") ?? "apify~instagram-scraper",
    input: (t) => ({ directUrls: [t], resultsType: "posts", resultsLimit: 12 }),
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "post",
    platform: "instagram",
  },
  facebook: {
    actor: () => env("APIFY_FACEBOOK_ACTOR") ?? "apify~facebook-posts-scraper",
    input: (t) => ({ startUrls: [{ url: t }], resultsLimit: 12 }),
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "post",
    platform: "facebook",
  },
  tiktok: {
    actor: () => env("APIFY_TIKTOK_ACTOR") ?? "clockworks~tiktok-scraper",
    input: (t) => ({ profiles: [handleOf(t)], resultsPerPage: 12 }),
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "post",
    platform: "tiktok",
  },
  // Delivery Actors vary a lot; require an explicit env Actor id (no default).
  // dz_omar/doordash-scraper requires `address` + `startUrls` (a store OR search URL).
  doordash: {
    actor: () => env("APIFY_DOORDASH_ACTOR"),
    input: (t, ctx) => {
      const url = t || (ctx?.searchQuery ? `https://www.doordash.com/search/store/${encodeURIComponent(ctx.searchQuery)}` : "");
      return { startUrls: [{ url }], address: ctx?.address ?? "", maxResults: 1, fetchReviews: false };
    },
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "menu",
    platform: "doordash",
  },
  // memo23/uber-eats-scraper: startUrls (store URL) OR searchQuery+address.
  // maxItems = number of STORES to scrape. For a linked store URL that's 1
  // (full menu). For a search it returns loosely-ranked stores, so scrape a
  // handful and let the name-match guard pick the business (may miss).
  ubereats: {
    actor: () => env("APIFY_UBEREATS_ACTOR"),
    input: (t, ctx) =>
      t
        ? { startUrls: [{ url: t }], maxItems: 1 }
        : { searchQuery: ctx?.searchQuery ?? "", address: ctx?.address ?? "", maxItems: 5 },
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "menu",
    platform: "ubereats",
  },
};

function parsePrice(s: any): number | undefined {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Gather store-level promotion strings from a delivery store record — field names
 *  vary by actor, so read several defensively. Deduped, capped. */
function promoStrings(...arrs: any[]): string[] {
  const out: string[] = [];
  for (const arr of arrs) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const t = typeof p === "string" ? p : (p?.title ?? p?.description ?? p?.text ?? p?.name ?? p?.promoTitle ?? p?.headline ?? "");
      if (t) out.push(String(t).replace(/\s+/g, " ").trim());
    }
  }
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}

/**
 * Map a DoorDash store record (dz_omar/doordash-scraper) into a rich menu
 * observation: menu items become structured offers (via structuredHints.jsonld,
 * reusing the pipeline's no-model offer path), promo items become sale offers,
 * and the store rating/delivery info rides in the text + hints.
 */
function mapDoorDashStore(r: any): RawObservation {
  const menuItems: any[] = [];
  const offers: any[] = [];
  const currency = r.currency ?? "USD";
  // Menu container + item field names vary by actor build, so read them
  // defensively (same as UberEats). Reading only price_display/price_cents left
  // every item price-less on actors that name the field differently → the items
  // were counted but produced 0 priced offers ("DoorDash attached, nothing came up").
  const categories = r.menu_categories ?? r.menuCategories ?? r.categories ?? r.menu ?? r.menus ?? [];
  for (const cat of categories) {
    for (const it of cat.items ?? cat.menuItems ?? cat.products ?? []) {
      const name = it.name ?? it.title ?? it.itemName ?? it.item_name;
      if (!name) continue;
      const current =
        parsePrice(it.price_display ?? it.priceDisplay ?? it.price ?? it.displayPrice ?? it.priceString ?? it.price_string ?? it.unitPrice ?? it.unit_price ?? it.priceText) ??
        (it.price_cents != null ? it.price_cents / 100 : it.priceCents != null ? it.priceCents / 100 : it.priceInCents != null ? it.priceInCents / 100 : undefined);
      const entry = { name, price: current, currency, section: cat.category_name ?? cat.categoryName ?? cat.name };
      const hasPromo = Array.isArray(it.badges) && it.badges.length > 0;
      if (hasPromo) offers.push(entry);
      else menuItems.push(entry);
    }
  }
  const itemCount = menuItems.length + offers.length;
  const promos = promoStrings(r.promotions, r.offers, r.deals, r.cmsBanners, r.storeOffers);
  const text =
    `${r.name} on DoorDash - ${r.rating ?? "?"} stars (${r.num_ratings ?? "?"} ratings) | ` +
    `${r.price_range_display ?? ""} | ${r.delivery_fee_display ?? ""} | ~${r.asap_minutes ?? "?"} min | ${itemCount} menu items.` +
    (promos.length ? ` | Promotions: ${promos.join("; ")}` : "");
  return {
    provider: "apify",
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    platform: "doordash",
    contentKind: "menu",
    externalRef: `doordash:${r.store_id}`,
    sourceUrl: r.url,
    text,
    media: r.cover_image ? [{ type: "image", url: r.cover_image }] : [],
    observedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(`${r.store_id}|${itemCount}|${r.rating}`).digest("hex"),
    raw: { store_id: r.store_id, rating: r.rating, num_ratings: r.num_ratings, delivery_fee: r.delivery_fee_display, asap_minutes: r.asap_minutes },
    structuredHints: {
      jsonld: { businessName: r.name, menuItems, offers },
      store: { rating: r.rating, num_ratings: r.num_ratings, delivery_fee: r.delivery_fee_display, asap_minutes: r.asap_minutes, price_range: r.price_range_display },
    },
  };
}

export function apifyConfigured(): boolean {
  return !!process.env.APIFY_TOKEN;
}
export function platformActorConfigured(platform: string): boolean {
  return apifyConfigured() && !!CONFIG[platform]?.actor();
}

function mapItem(cfg: PlatformConfig, it: any): RawObservation {
  const text = it.caption ?? it.text ?? it.title ?? it.description ?? it.postText ?? "";
  const url = it.url ?? it.postUrl ?? it.webVideoUrl ?? it.link;
  const media: RawObservation["media"] = [];
  // Image URLs live under different keys per platform/actor (IG: displayUrl/images;
  // FB posts-scraper: media[].photo_image / image / attachments). Gather tolerantly.
  const pushImg = (u: unknown) => { if (typeof u === "string" && /^https?:\/\//.test(u)) media.push({ type: "image", url: u }); };
  pushImg(it.displayUrl); pushImg(it.image); pushImg(it.imageUrl); pushImg(it.photoUrl); pushImg(it.thumbnailUrl);
  for (const img of it.images ?? []) pushImg(typeof img === "string" ? img : (img?.url ?? img?.src ?? img?.image));
  for (const m of it.media ?? []) {
    const t = String(m?.type ?? "").toLowerCase();
    if (t && t !== "image" && t !== "photo") continue;
    pushImg(typeof m === "string" ? m : (m?.url ?? m?.image ?? m?.src ?? m?.thumbnail ?? m?.photo_image?.uri));
  }
  for (const a of it.attachments ?? []) pushImg(a?.url ?? a?.image?.uri ?? a?.media?.image?.uri ?? a?.photo_image?.uri);
  if (it.videoUrl || it.webVideoUrl) media.push({ type: "video", url: it.videoUrl ?? it.webVideoUrl });
  // Engagement metrics (IG likesCount/commentsCount/videoViewCount; TikTok
  // diggCount/playCount…). Stored as a trailing media entry so it persists in
  // content_item.media without a schema change and never displaces image[0].
  const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : undefined; };
  const likes = num(it.likesCount ?? it.likeCount ?? it.diggCount);
  const comments = num(it.commentsCount ?? it.commentCount ?? it.comments);
  const views = num(it.videoViewCount ?? it.videoPlayCount ?? it.playCount ?? it.viewCount);
  if (likes != null || comments != null || views != null) {
    media.push({ type: "metrics", likes, comments, views } as any);
  }
  return {
    provider: "apify",
    provenance: cfg.provenance,
    platform: cfg.platform,
    contentKind: cfg.contentKind,
    externalRef: String(it.id ?? it.shortCode ?? url ?? Math.random()),
    sourceUrl: url,
    text,
    media,
    publishedAt: it.timestamp ?? it.createTimeISO ?? it.date,
    observedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(`${it.id ?? url}|${text}`).digest("hex"),
    raw: it,
  };
}

/**
 * Map an Uber Eats store record (memo23/uber-eats-scraper) into a menu
 * observation. Item field names vary, so price/name are read defensively.
 */
function mapUberEatsStore(r: any): RawObservation {
  const currency = r.currencyCode ?? "USD";
  const menuItems: any[] = [];
  for (const it of r.menuItems ?? []) {
    const name = it.name ?? it.title ?? it.itemName;
    if (!name) continue;
    const price =
      parsePrice(it.price ?? it.priceString ?? it.priceTagline ?? it.itemPrice ?? it.priceText) ??
      (it.priceInCents != null ? it.priceInCents / 100 : it.priceCents != null ? it.priceCents / 100 : undefined);
    menuItems.push({ name, price, currency, section: it.section ?? it.sectionName ?? it.categoryName });
  }
  const name = r.shopName ?? r.title ?? r.seoTitle ?? "Store";
  const promos = promoStrings(r.promos, r.promotions, r.offers, r.storeOffers);
  const text =
    `${name} on Uber Eats - ${r.ratingValue ?? "?"} stars (${r.reviewCount ?? "?"} reviews) | ` +
    `${r.priceBucket ?? ""} | ${r.deliveryFeeText ?? ""} | ${r.etaRange ?? ""} | ${menuItems.length} menu items.` +
    (promos.length ? ` | Promotions: ${promos.join("; ")}` : "");
  const url = r.canonicalUrl ?? r.url ?? r.restaurantUrl;
  return {
    provider: "apify",
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    platform: "ubereats",
    contentKind: "menu",
    externalRef: `ubereats:${r.storeId ?? r.storeUuid ?? url}`,
    sourceUrl: url,
    text,
    media: r.image ? [{ type: "image", url: r.image }] : [],
    observedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(`${r.storeId ?? url}|${menuItems.length}|${r.ratingValue}`).digest("hex"),
    raw: { storeId: r.storeId, rating: r.ratingValue, reviews: r.reviewCount, deliveryFee: r.deliveryFeeText, eta: r.etaRange, promos: r.promos?.length },
    structuredHints: {
      jsonld: { businessName: name, menuItems, offers: [] },
      store: { rating: r.ratingValue, num_ratings: r.reviewCount, delivery_fee: r.deliveryFeeText, eta: r.etaRange, price_range: r.priceBucket },
    },
  };
}

/**
 * Run the platform's Actor for one target (profile/page/store URL) and return
 * normalized observations. Returns [] (never throws) when not configured, so the
 * collection worker degrades cleanly.
 */
export interface ApifyResult {
  items: RawObservation[];
  costUsd: number; // the Actor run's real usage cost (guide §16.1)
  error?: string;  // set when the run failed to start/finish (out of credits, bad token, timeout) — surfaced to provider_run instead of being swallowed as "succeeded n=0"
}

export async function collectApifyPlatform(
  platform: string,
  target: string,
  opts: { maxMs?: number; address?: string; searchQuery?: string } = {},
): Promise<ApifyResult> {
  const empty: ApifyResult = { items: [], costUsd: 0 };
  const token = process.env.APIFY_TOKEN;
  const cfg = CONFIG[platform];
  if (!token || !cfg) return empty;
  const actor = cfg.actor();
  if (!actor) return empty; // no Actor configured for this platform
  // Delivery actors need an address, and either a store URL or a search query.
  if ((platform === "doordash" || platform === "ubereats")) {
    if (!opts.address) return empty;
    if (!target && !opts.searchQuery) return empty;
  }

  const maxMs = opts.maxMs ?? 75000;
  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg.input(target, { address: opts.address, searchQuery: opts.searchQuery })),
    });
    // A rejected run-start is the tell-tale of an account problem (402 out of
    // credits, 401 bad token, 429 rate-limited). Capture it so it's visible in
    // provider_run rather than looking like an empty-but-successful scrape.
    if (!runRes.ok) return { items: [], costUsd: 0, error: `run start ${runRes.status}: ${(await runRes.text().catch(() => "")).slice(0, 140)}` };
    const run = (await runRes.json()) as any;
    const runId = run.data?.id;
    if (!runId) return { items: [], costUsd: 0, error: "run start: no run id in response" };

    const deadline = Date.now() + maxMs;
    let datasetId: string | undefined;
    let costUsd = 0;
    while (Date.now() < deadline) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json() as any);
      const s = st.data?.status;
      costUsd = st.data?.usageTotalUsd ?? costUsd;
      if (s === "SUCCEEDED") {
        datasetId = st.data?.defaultDatasetId;
        break;
      }
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return { items: [], costUsd, error: `run ${s}` };
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return { items: [], costUsd, error: "run still going past time budget" }; // still running past our budget

    const raw = (await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`,
    ).then((r) => r.json())) as any[];
    let items: RawObservation[];
    if (platform === "doordash") {
      items = raw.filter((it) => it?.record_type === "store" || it?.menu_categories).map(mapDoorDashStore);
    } else if (platform === "ubereats") {
      items = raw.filter((it) => it?.shopName || it?.menuItems).map(mapUberEatsStore);
    } else {
      items = raw.map((it) => mapItem(cfg, it));
    }
    return { items, costUsd };
  } catch (e) {
    return { items: [], costUsd: 0, error: (e as Error).message };
  }
}

export const APIFY_PLATFORMS = Object.keys(CONFIG);

// ── Profile stats (followers etc.) ──────────────────────────────────────────
// A dedicated, lightweight profile scrape that returns account-level stats
// (follower count, posts, verified) reliably — unlike post scrapers, where a
// follower count is inconsistently present. Used to bank a follower time series.
export interface ProfileStats { followers?: number; following?: number; posts?: number; verified?: boolean; costUsd: number }

export async function collectProfileStats(
  platform: string,
  target: string,
  opts: { maxMs?: number } = {},
): Promise<ProfileStats> {
  const token = process.env.APIFY_TOKEN;
  const actor =
    platform === "instagram" ? (process.env.APIFY_INSTAGRAM_PROFILE_ACTOR ?? "apify~instagram-profile-scraper")
    : platform === "facebook" ? (process.env.APIFY_FACEBOOK_PAGE_ACTOR ?? "apify~facebook-pages-scraper")
    : platform === "tiktok" ? (process.env.APIFY_TIKTOK_PROFILE_ACTOR ?? "clockworks~tiktok-scraper")
    : platform === "youtube" ? process.env.APIFY_YOUTUBE_CHANNEL_ACTOR   // no default — actor varies
    : undefined;
  if (!token || !actor) return { costUsd: 0 };
  const input = platform === "instagram" ? { usernames: [handleOf(target)] }
    : platform === "tiktok" ? { profiles: [handleOf(target)], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false }
    : { startUrls: [{ url: target }] };
  const maxMs = opts.maxMs ?? 40000;
  const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : undefined; };
  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (!runRes.ok) return { costUsd: 0 };
    const runId = ((await runRes.json()) as any).data?.id;
    if (!runId) return { costUsd: 0 };
    const deadline = Date.now() + maxMs;
    let datasetId: string | undefined; let costUsd = 0;
    while (Date.now() < deadline) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json() as any);
      costUsd = st.data?.usageTotalUsd ?? costUsd;
      const s = st.data?.status;
      if (s === "SUCCEEDED") { datasetId = st.data?.defaultDatasetId; break; }
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return { costUsd };
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return { costUsd };
    const raw = (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true&limit=1`).then((r) => r.json())) as any[];
    const it = (raw ?? [])[0] ?? {};
    switch (platform) {
      case "instagram":
        return { followers: num(it.followersCount), following: num(it.followsCount), posts: num(it.postsCount ?? it.mediaCount), verified: !!it.verified, costUsd };
      case "tiktok": {
        const a = (it.authorMeta ?? {}) as any;
        return { followers: num(a.fans ?? it.fans ?? it.followers ?? it.followersCount), following: num(a.following), posts: num(a.video ?? it.videoCount), verified: !!(a.verified ?? it.verified), costUsd };
      }
      case "youtube":
        return { followers: num(it.subscriberCount ?? it.numberOfSubscribers ?? it.subscribers ?? it.channelTotalSubscribers), posts: num(it.videosCount ?? it.channelTotalVideos), verified: !!it.verified, costUsd };
      default: // facebook page: follower/like fields vary by actor
        return { followers: num(it.followers ?? it.followersCount ?? it.likes ?? it.likesCount ?? it.pageLikes), verified: !!it.verified, costUsd };
    }
  } catch { return { costUsd: 0 }; }
}

// ── Hashtag discovery (the national industry corpus) ────────────────────────
// Scrapes the TOP posts under a category hashtag so the best content + accounts
// EMERGE from engagement (discovery-first), rather than a hand-curated account
// list. Dormant unless APIFY_TOKEN is set; the Actor id is env-overridable.
export interface IndustryPost {
  externalRef: string; url?: string; authorHandle?: string; caption: string;
  likes?: number; comments?: number; views?: number; publishedAt?: string;
}
export function hashtagActorConfigured(): boolean {
  return !!process.env.APIFY_TOKEN;
}

// ── Meta Ad Library (what rivals are PAYING to promote) ─────────────────────
// Meta's official Ad Library API only returns political/issue ads (or EU
// commercial ads), so US commercial ads must come from scraping the Ad Library
// site. Dormant unless APIFY_TOKEN + APIFY_AD_LIBRARY_ACTOR are set (no default —
// Ad Library actors vary; the owner picks a working one).
export interface RivalAd {
  advertiser: string; text: string; cta?: string; link?: string; snapshotUrl?: string;
  platforms?: string[]; since?: string;
}
// Default to the validated pay-per-item Ad Library scraper so the feature needs
// only APIFY_TOKEN (override with APIFY_AD_LIBRARY_ACTOR to use a different one).
const AD_LIBRARY_ACTOR = () => process.env.APIFY_AD_LIBRARY_ACTOR ?? "apify~facebook-ads-scraper";
export function adLibraryConfigured(): boolean {
  return !!process.env.APIFY_TOKEN;
}

/** Map one Ad Library dataset row (apify/facebook-ads-scraper shape) → RivalAd.
 *  Exported so a one-off can re-map already-scraped datasets without re-paying. */
export function mapAdItem(it: any): RivalAd {
  const s = it.snapshot ?? {};
  const card = Array.isArray(s.cards) ? s.cards[0] : undefined;
  const id = it.adArchiveID ?? it.adArchiveId ?? it.adarchiveid;
  return {
    advertiser: it.pageName ?? s.pageName ?? it.page_name ?? it.advertiser ?? "A rival",
    text: String(s.body?.text ?? s.body ?? card?.body ?? it.ad_creative_body ?? it.text ?? "").replace(/\s+/g, " ").trim(),
    cta: s.ctaText ?? card?.ctaText ?? it.cta_type ?? undefined,
    link: s.linkUrl ?? card?.linkUrl ?? it.link_url ?? undefined,
    snapshotUrl: id ? `https://www.facebook.com/ads/library/?id=${id}` : (it.ad_snapshot_url ?? it.url ?? undefined),
    platforms: it.publisherPlatform ?? it.publisher_platforms ?? s.platforms ?? undefined,
    since: it.startDateFormatted ?? it.ad_delivery_start_time ?? it.start_date ?? undefined,
  };
}

export async function collectApifyAdLibrary(
  query: string,
  opts: { limit?: number; maxMs?: number; country?: string } = {},
): Promise<{ items: RivalAd[]; costUsd: number }> {
  const empty = { items: [] as RivalAd[], costUsd: 0 };
  const token = process.env.APIFY_TOKEN;
  const actor = AD_LIBRARY_ACTOR();
  if (!token || !query.trim()) return empty;
  const country = opts.country ?? "US";
  const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(query)}&search_type=keyword_unordered`;
  const maxMs = opts.maxMs ?? 90000;

  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // pass several common input shapes; actors ignore the keys they don't use
      body: JSON.stringify({ urls: [{ url: searchUrl }], startUrls: [{ url: searchUrl }], searchTerms: [query], count: opts.limit ?? 20, activeStatus: "active", country }),
    });
    if (!runRes.ok) return empty;
    const runId = ((await runRes.json()) as any).data?.id;
    if (!runId) return empty;

    const deadline = Date.now() + maxMs;
    let datasetId: string | undefined;
    let costUsd = 0;
    while (Date.now() < deadline) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json() as any);
      costUsd = st.data?.usageTotalUsd ?? costUsd;
      const s = st.data?.status;
      if (s === "SUCCEEDED") { datasetId = st.data?.defaultDatasetId; break; }
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return { items: [], costUsd };
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return { items: [], costUsd };

    const raw = (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`).then((r) => r.json())) as any[];
    const items: RivalAd[] = (raw ?? []).map((it) => mapAdItem(it)).filter((a) => a.text.length > 0 || a.snapshotUrl);
    return { items, costUsd };
  } catch {
    return empty;
  }
}

export async function collectApifyHashtag(
  tag: string,
  opts: { limit?: number; maxMs?: number } = {},
): Promise<{ items: IndustryPost[]; costUsd: number }> {
  const empty = { items: [] as IndustryPost[], costUsd: 0 };
  const token = process.env.APIFY_TOKEN;
  if (!token) return empty;
  const actor = process.env.APIFY_INSTAGRAM_HASHTAG_ACTOR ?? "apify~instagram-hashtag-scraper";
  const clean = tag.replace(/^#/, "").trim();
  if (!clean) return empty;
  const maxMs = opts.maxMs ?? 90000;
  const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : undefined; };

  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hashtags: [clean], resultsType: "posts", resultsLimit: opts.limit ?? 30 }),
    });
    if (!runRes.ok) return empty;
    const runId = ((await runRes.json()) as any).data?.id;
    if (!runId) return empty;

    const deadline = Date.now() + maxMs;
    let datasetId: string | undefined;
    let costUsd = 0;
    while (Date.now() < deadline) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json() as any);
      costUsd = st.data?.usageTotalUsd ?? costUsd;
      const s = st.data?.status;
      if (s === "SUCCEEDED") { datasetId = st.data?.defaultDatasetId; break; }
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return { items: [], costUsd };
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return { items: [], costUsd };

    const raw = (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`).then((r) => r.json())) as any[];
    const items: IndustryPost[] = (raw ?? []).map((it) => ({
      externalRef: String(it.id ?? it.shortCode ?? it.url ?? it.postUrl ?? Math.random()),
      url: it.url ?? it.postUrl ?? it.webVideoUrl,
      authorHandle: it.ownerUsername ?? it.username ?? it.ownerFullName,
      caption: String(it.caption ?? it.text ?? it.title ?? "").replace(/\s+/g, " ").trim(),
      likes: num(it.likesCount ?? it.likeCount),
      comments: num(it.commentsCount ?? it.commentCount),
      views: num(it.videoViewCount ?? it.videoPlayCount ?? it.viewCount),
      publishedAt: it.timestamp ?? it.createTimeISO ?? it.date,
    })).filter((p) => p.caption.length > 0 || p.url);
    return { items, costUsd };
  } catch {
    return empty;
  }
}
