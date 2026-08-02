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
  for (const cat of r.menu_categories ?? []) {
    for (const it of cat.items ?? []) {
      const current = parsePrice(it.price_display) ?? (it.price_cents != null ? it.price_cents / 100 : undefined);
      if (!it.name) continue;
      const entry = { name: it.name, price: current, currency, section: cat.category_name };
      const hasPromo = Array.isArray(it.badges) && it.badges.length > 0;
      if (hasPromo) offers.push(entry);
      else menuItems.push(entry);
    }
  }
  const itemCount = menuItems.length + offers.length;
  const text =
    `${r.name} on DoorDash - ${r.rating ?? "?"} stars (${r.num_ratings ?? "?"} ratings) | ` +
    `${r.price_range_display ?? ""} | ${r.delivery_fee_display ?? ""} | ~${r.asap_minutes ?? "?"} min | ${itemCount} menu items.`;
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
  if (it.displayUrl) media.push({ type: "image", url: it.displayUrl });
  for (const img of it.images ?? []) media.push({ type: "image", url: img });
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
  const text =
    `${name} on Uber Eats - ${r.ratingValue ?? "?"} stars (${r.reviewCount ?? "?"} reviews) | ` +
    `${r.priceBucket ?? ""} | ${r.deliveryFeeText ?? ""} | ${r.etaRange ?? ""} | ${menuItems.length} menu items.`;
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
    if (!runRes.ok) return empty;
    const run = (await runRes.json()) as any;
    const runId = run.data?.id;
    if (!runId) return empty;

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
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return { items: [], costUsd };
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return { items: [], costUsd }; // still running past our budget

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
  } catch {
    return empty;
  }
}

export const APIFY_PLATFORMS = Object.keys(CONFIG);
