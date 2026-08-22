import { createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { collectApifyPlatform, apifyConfigured, collectProfileStats } from "@/lib/providers/apify/platforms";
import { youtubeChannelStats } from "@/lib/providers/youtube";
import { refundCredits, planOfOrg, retentionDaysForPlan } from "@/lib/credits";

/**
 * Flyer deal extraction — the grocery goldmine. Groceries/restaurants post their
 * weekly SALES as flyer/poster IMAGES (prices live in the image, not the caption),
 * and scraped CDN urls 403 once their signature expires. So we scrape competitors'
 * Instagram + Facebook FRESH, immediately download the flyer images to Supabase
 * Storage, then VISION-extract the sale items + prices from the stored posters.
 *
 * Reading is slow (sequential per-profile scrapes), so it runs as an ASYNC JOB:
 * `enqueueFlyerJob` resolves the profile list and stores it on goals.flyerJob;
 * `runFlyerBatch` processes a few profiles per call (client-driven ticks), MERGING
 * results into goals.flyerDeals so coverage accumulates and never regresses.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const BUCKET = "flyers";
type Svc = ReturnType<typeof createServiceClient>;

export interface FlyerDeal { rival: string; item: string; price?: string; terms?: string; imageUrl?: string; postUrl?: string; source?: string; postedAt?: string; seenAt?: string; lastSeen?: string }
export interface FlyerReport { deals: FlyerDeal[]; flyersRead: number; at: string; empty?: boolean }
export interface FlyerProfile { url: string; rival: string; platform: string; own?: boolean; placeId?: string }
const googleConfigured = () => !!process.env.GOOGLE_MAPS_API_KEY;

/** Public photo URLs for a Google place (menu boards, flyers, storefront) via the
 *  Places Photo endpoint. Returns [] unless GOOGLE_MAPS_API_KEY is set. */
async function fetchGooglePhotoUrls(placeId: string, per: number): Promise<string[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "photos" } });
    if (!res.ok) return [];
    const p = (await res.json()) as any;
    return (p.photos ?? []).slice(0, per).map((ph: any) => `https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=1600&key=${key}`);
  } catch { return []; }
}
export interface FlyerJob {
  status: "running" | "done" | "error";
  profiles: FlyerProfile[];
  cursor: number;
  total: number;
  flyersRead: number;
  dealsFound: number;
  charged: number;
  orgId: string;
  costUsd: number;
  startedAt: string;
  updatedAt: string;
}

interface Flyer { rival: string; caption: string; postUrl?: string; storedUrl: string; base64: string; mediaType: string; source: string; postedAt?: string }

export function flyersConfigured(): boolean {
  // Need an AI key to read images, plus at least one image source (social via
  // Apify, or Google Maps photos via the Maps key).
  return (apifyConfigured() || googleConfigured()) && isLlmConfigured();
}

async function ensureBucket(svc: Svc) {
  try { await svc.storage.createBucket(BUCKET, { public: true }); } catch { /* already exists */ }
}
function keyOf(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function storeImage(svc: Svc, url: string, key: string): Promise<{ publicUrl: string; base64: string; mediaType: string } | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "image/*,*/*", referer: "https://www.instagram.com/" } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) return null;
    const path = `${key}.jpg`;
    const { error } = await svc.storage.from(BUCKET).upload(path, buf, { contentType: ct, upsert: true });
    if (error) return null;
    return { publicUrl: svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, base64: buf.toString("base64"), mediaType: ct };
  } catch { return null; }
}

const VISION_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    images: {
      type: "array",
      description: "One entry PER image in order. For a sale flyer, list its items+prices; for a lifestyle/brand photo with no prices, return an empty deals array.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          imageIndex: { type: "integer", description: "the [index] of the image (0-based)" },
          context: { type: "array", items: { type: "string" }, description: "2-4 short phrases on what THIS image shows about the business BEYOND prices — featured products/dishes/services, quality/freshness/ambiance signals, visual themes, or notable/new items. Fill this for EVERY image, including lifestyle/brand/ambiance photos that have no prices." },
          deals: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                item: { type: "string", description: "the offering on the sign — a product, dish, service, treatment, package or combo" },
                price: { type: "string", description: "the price exactly as printed (e.g. '$0.99/lb', '2 for $5', '$45/session', 'from $120'), or '' if none" },
                terms: { type: "string", description: "terms/validity if shown (e.g. 'thru Sun', 'limit 2', 'new clients'), else ''" },
              },
              required: ["item"],
            },
          },
        },
        required: ["imageIndex", "deals"],
      },
    },
  },
  required: ["images"],
};
const VISION_SYSTEM =
  "You read a local business's PROMOTIONAL images across any industry — sale flyers, menu boards, service & treatment price lists, price signs. For each image, list every OFFERING (a product, dish, service, treatment, package or combo) with its price EXACTLY as printed and any terms/validity. Works the same for a grocery flyer, a restaurant menu special, a salon service list, a med-spa treatment menu, or a barber's price board. Read only what is visibly printed — never guess a price. If an image is a lifestyle/brand/logo photo with no offerings or prices, return an empty deals array for it. SEPARATELY, for EVERY image (offering or not), fill `context` with 2-4 short phrases capturing what it conveys about the business beyond prices — the offerings/products/dishes/services shown, quality/freshness/ambiance, visual style/theme, or anything notable or new. This visual read is used to understand each business, so never leave context empty for a real photo.";

/** Competitors' Instagram + Facebook profiles, interleaved so both platforms are sampled. */
export async function resolveFlyerProfiles(ws: WorkspaceRow, svc: Svc, maxCompetitors = 8): Promise<FlyerProfile[]> {
  const ids = await workspaceBusinessIds(ws, svc as any);
  const compIds = ids.competitorIds.slice(0, maxCompetitors);
  if (!compIds.length) return [];
  const [{ data: biz }, { data: idents }] = await Promise.all([
    svc.from("business").select("id, canonical_name, attributes").in("id", compIds),
    svc.from("external_identity").select("business_id, url, platform").in("platform", ["instagram", "facebook"]).in("business_id", compIds),
  ]);
  const nameById = new Map((biz ?? []).map((b: any) => [b.id as string, b.canonical_name as string]));
  const all: FlyerProfile[] = (idents ?? []).map((r: any) => ({ url: r.url as string, rival: nameById.get(r.business_id) ?? "A rival", platform: r.platform as string }));
  const igT = all.filter((t) => t.platform === "instagram");
  const fbT = all.filter((t) => t.platform === "facebook");
  const ordered: FlyerProfile[] = [];
  for (let i = 0; i < Math.max(igT.length, fbT.length); i++) { if (igT[i]) ordered.push(igT[i]); if (fbT[i]) ordered.push(fbT[i]); }
  // Google Maps photos — one profile per business that has a place_id (works even
  // for rivals with no IG/FB, so coverage is identical across businesses).
  if (googleConfigured()) {
    for (const b of biz ?? []) {
      const pid = (b as any).attributes?.place_id;
      if (pid) ordered.push({ url: `https://www.google.com/maps/place/?q=place_id:${pid}`, rival: (b as any).canonical_name ?? "A rival", platform: "google", placeId: pid });
    }
  }
  return ordered;
}

/** The OWNER's own Instagram + Facebook profiles — so we can read their advertised
 *  prices and compare them to rivals'. */
export async function resolveOwnProfiles(ws: WorkspaceRow, svc: Svc): Promise<FlyerProfile[]> {
  if (!ws.target_business_id) return [];
  const [{ data: idents }, { data: b }] = await Promise.all([
    svc.from("external_identity").select("url, platform").in("platform", ["instagram", "facebook"]).eq("business_id", ws.target_business_id),
    svc.from("business").select("attributes").eq("id", ws.target_business_id).maybeSingle(),
  ]);
  const ig = (idents ?? []).filter((i: any) => i.platform === "instagram");
  const fb = (idents ?? []).filter((i: any) => i.platform === "facebook");
  const out: FlyerProfile[] = [];
  for (let i = 0; i < Math.max(ig.length, fb.length); i++) {
    if (ig[i]) out.push({ url: (ig[i] as any).url, rival: ws.name, platform: "instagram", own: true });
    if (fb[i]) out.push({ url: (fb[i] as any).url, rival: ws.name, platform: "facebook", own: true });
  }
  const pid = (b as any)?.attributes?.place_id;
  if (googleConfigured() && pid) out.push({ url: `https://www.google.com/maps/place/?q=place_id:${pid}`, rival: ws.name, platform: "google", own: true, placeId: pid });
  return out;
}

async function scrapeProfileFlyers(ws: WorkspaceRow, svc: Svc, t: FlyerProfile, per: number): Promise<{ flyers: Flyer[]; costUsd: number }> {
  // Google Maps photos path — menu boards / flyers posted on the business's
  // Google profile. Same download + vision pipeline as social flyers.
  if (t.platform === "google") {
    if (!t.placeId) return { flyers: [], costUsd: 0 };
    const urls = await fetchGooglePhotoUrls(t.placeId, per);
    const flyers: Flyer[] = [];
    for (const u of urls) {
      const stored = await storeImage(svc, u, `${ws.id}/g_${keyOf(t.rival + u)}`);
      if (!stored) continue;
      flyers.push({ rival: t.rival, caption: "", postUrl: t.url, storedUrl: stored.publicUrl, base64: stored.base64, mediaType: stored.mediaType, source: "google" });
    }
    return { flyers, costUsd: Number((0.007 * urls.length).toFixed(4)) };
  }
  const { items, costUsd } = await collectApifyPlatform(t.platform, t.url, { maxMs: 70000 });
  const flyers: Flyer[] = [];
  let n = 0;
  for (const it of items) {
    if (n >= per) break;
    const imgUrl = (it.media ?? []).find((m) => (m as any).type === "image" && (m as any).url) as any;
    if (!imgUrl?.url) continue;
    const stored = await storeImage(svc, imgUrl.url, `${ws.id}/${keyOf(t.rival + imgUrl.url)}`);
    if (!stored) continue;
    flyers.push({ rival: t.rival, caption: String(it.text ?? "").slice(0, 200), postUrl: (it as any).sourceUrl, storedUrl: stored.publicUrl, base64: stored.base64, mediaType: stored.mediaType, source: t.platform, postedAt: (it as any).publishedAt });
    n++;
  }
  return { flyers, costUsd };
}

type TLPoint = { date: string; channel: string; followers?: number };
/** Bank a dated per-channel follower point (one per rival×channel per day). */
function bankChannelFollowers(timeline: Record<string, TLPoint[]>, rival: string, channel: string, followers: number, now: string, retentionDays: number) {
  const today = now.slice(0, 10);
  const arr = (timeline[rival] ?? []).filter((p) => !(p.channel === channel && p.date.slice(0, 10) === today));
  arr.push({ date: now, channel, followers });
  const cutoff = Date.now() - retentionDays * 86400000;
  timeline[rival] = arr.filter((p) => new Date(p.date).getTime() >= cutoff).slice(-300);
}
async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) { const idx = i++; try { await tasks[idx](); } catch { /* ignore */ } }
  }));
}
/** Dedicated all-channel follower snapshot: fetch each competitor's + the owner's
 *  IG/FB/TikTok/YouTube stats in parallel, then SELF-COMMIT the per-channel points
 *  to goals.socialTimeline in its own update — so followers persist every scan even
 *  if the heavier flyer image scrape later times out. Returns points banked. */
async function captureFollowers(ws: WorkspaceRow, svc: Svc, retentionDays: number): Promise<number> {
  const now = new Date().toISOString();
  const ids = await workspaceBusinessIds(ws, svc as any);
  const bizIds = [...ids.competitorIds, ...(ws.target_business_id ? [ws.target_business_id] : [])];
  if (!bizIds.length) return 0;
  const [{ data: biz }, { data: idents }] = await Promise.all([
    svc.from("business").select("id, canonical_name").in("id", bizIds),
    svc.from("external_identity").select("business_id, url, platform").in("platform", ["instagram", "facebook", "tiktok", "youtube"]).in("business_id", bizIds),
  ]);
  const nameById = new Map<string, string>((biz ?? []).map((b: any) => [b.id as string, b.canonical_name as string]));
  const results: { name: string; channel: string; followers: number }[] = [];
  const tasks = (idents ?? []).map((r: any) => async () => {
    // YouTube subscribers come from the official Data API; everything else via the profile-stats scrape
    const followers = r.platform === "youtube"
      ? (await youtubeChannelStats(r.url)).subscribers
      : (await collectProfileStats(r.platform, r.url, { maxMs: 35000 })).followers;
    if (followers != null) results.push({ name: nameById.get(r.business_id) ?? "?", channel: r.platform, followers });
  });
  await runPool(tasks, 5);
  if (!results.length) return 0;
  // self-commit: read → bank → write ONLY socialTimeline, in its own short update
  const { data: gRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = ((gRow?.goals as Record<string, unknown>) ?? {});
  const timeline = { ...((goals.socialTimeline as Record<string, TLPoint[]>) ?? {}) };
  for (const r of results) bankChannelFollowers(timeline, r.name, r.channel, r.followers, now, retentionDays);
  await svc.from("workspace").update({ goals: { ...goals, socialTimeline: timeline } }).eq("id", ws.id);
  return results.length;
}

async function visionExtract(ws: WorkspaceRow, flyers: Flyer[]): Promise<{ deals: FlyerDeal[]; visuals: { rival: string; note: string }[] }> {
  const deals: FlyerDeal[] = [];
  const visuals: { rival: string; note: string }[] = [];
  const BATCH = 6;
  for (let i = 0; i < flyers.length; i += BATCH) {
    const batch = flyers.slice(i, i + BATCH);
    try {
      const { data } = await getLlm().callStructured<{ images: { imageIndex: number; context?: string[]; deals: { item: string; price?: string; terms?: string }[] }[] }>({
        system: VISION_SYSTEM,
        text: `These are ${batch.length} images from local ${ws.vertical} businesses' posts/pages, in order [0..${batch.length - 1}]. For each: extract any sale items + prices, AND fill context with what the image shows about the business.`,
        images: batch.map((f) => ({ base64: f.base64, mediaType: f.mediaType })),
        schema: VISION_SCHEMA, tier: "extract", maxTokens: 2600,
      });
      for (const im of Array.isArray(data.images) ? data.images : []) {
        const src = batch[Number(im.imageIndex)];
        if (!src) continue;
        for (const d of Array.isArray(im.deals) ? im.deals : []) {
          const item = String(d.item ?? "").replace(/\s+/g, " ").trim();
          if (!item) continue;
          deals.push({ rival: src.rival, item, price: String(d.price ?? "").trim() || undefined, terms: String(d.terms ?? "").trim() || undefined, imageUrl: src.storedUrl, postUrl: src.postUrl, source: src.source, postedAt: src.postedAt });
        }
        for (const c of Array.isArray(im.context) ? im.context : []) {
          const note = String(c ?? "").replace(/\s+/g, " ").trim();
          if (note.length > 3) visuals.push({ rival: src.rival, note });
        }
      }
    } catch { /* skip this batch */ }
  }
  return { deals, visuals };
}

export interface VisualsReport { businesses: { name: string; isYou: boolean; notes: string[] }[]; at: string; empty?: boolean }

/** Merge freshly-read visual notes into the cache: businesses seen THIS run get
 *  their notes refreshed (deduped, newest first, capped); businesses not seen keep
 *  their previous notes. Non-price context — "what their photos show". */
function mergeVisuals(prev: VisualsReport | undefined, fresh: { rival: string; note: string }[], ownName: string, now: string): VisualsReport {
  const freshByBiz = new Map<string, { name: string; notes: string[] }>();
  for (const v of fresh) {
    const k = v.rival.toLowerCase();
    const e = freshByBiz.get(k) ?? { name: v.rival, notes: [] };
    if (!e.notes.some((n) => n.toLowerCase() === v.note.toLowerCase())) e.notes.push(v.note);
    freshByBiz.set(k, e);
  }
  const out = new Map<string, { name: string; isYou: boolean; notes: string[] }>();
  for (const b of prev?.businesses ?? []) out.set(b.name.toLowerCase(), { ...b, notes: [...b.notes] });
  for (const [k, e] of freshByBiz) out.set(k, { name: e.name, isYou: e.name.toLowerCase() === ownName.toLowerCase(), notes: e.notes.slice(0, 8) });
  const businesses = [...out.values()].filter((b) => b.notes.length);
  return { businesses, at: now, ...(businesses.length ? {} : { empty: true }) };
}

/** Read the cached visual signals (never scrapes). */
export async function getVisuals(ws: WorkspaceRow): Promise<VisualsReport> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  return ((data?.goals as { visuals?: VisualsReport } | null)?.visuals) ?? { businesses: [], at: new Date().toISOString(), empty: true };
}

const HISTORY_CAP = 500;     // safety bound on stored items
/** Append-only, date-stamped merge: a deal keeps the `seenAt` from the FIRST time
 *  we caught it (so we can tell new vs ongoing), a changed price is a NEW dated
 *  entry, and items older than the plan's retention window are pruned. */
function mergeDeals(prev: FlyerDeal[], fresh: FlyerDeal[], now: string, retentionDays: number): FlyerDeal[] {
  const dkey = (d: FlyerDeal) => `${d.rival}|${d.item}|${d.price ?? ""}`.toLowerCase();
  const prevByKey = new Map(prev.map((d) => [dkey(d), d] as const));
  const freshKeys = new Set<string>();
  const out: FlyerDeal[] = [];
  for (const d of fresh) {
    const k = dkey(d); if (freshKeys.has(k)) continue; freshKeys.add(k);
    const was = prevByKey.get(k);
    out.push({ ...d, seenAt: was?.seenAt ?? now, postedAt: d.postedAt ?? was?.postedAt, lastSeen: now } as FlyerDeal);
  }
  for (const d of prev) { if (!freshKeys.has(dkey(d))) out.push(d); }
  const cutoff = Date.now() - retentionDays * 86400000;
  return out
    .filter((d) => { const t = d.seenAt ? new Date(d.seenAt).getTime() : Date.now(); return t >= cutoff; })
    .sort((a, b) => new Date(b.seenAt ?? 0).getTime() - new Date(a.seenAt ?? 0).getTime())
    .slice(0, HISTORY_CAP);
}

// ── Async job ───────────────────────────────────────────────────────────────

/** Start a flyer read: resolve the profile list and store the job. Charging is
 *  done by the caller (the run route) before enqueuing. */
export async function enqueueFlyerJob(ws: WorkspaceRow, orgId: string, charged: number): Promise<{ total: number }> {
  const svc = createServiceClient();
  await ensureBucket(svc);
  // owner's own profiles first (so their prices are captured early), then rivals'
  const [ownProfiles, rivalProfiles] = await Promise.all([resolveOwnProfiles(ws, svc), resolveFlyerProfiles(ws, svc)]);
  const profiles = [...ownProfiles, ...rivalProfiles];
  const now = new Date().toISOString();
  const job: FlyerJob = { status: "running", profiles, cursor: 0, total: profiles.length, flyersRead: 0, dealsFound: 0, charged, orgId, costUsd: 0, startedAt: now, updatedAt: now };
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), flyerJob: job } }).eq("id", ws.id);
  return { total: profiles.length };
}

export interface BatchResult { status: "running" | "done" | "idle"; processed: number; total: number; flyersRead: number; deals: number }

/** Process the next batch of the flyer job (client-driven tick). Each call handles
 *  a couple of profiles within a wall-clock budget and merges results, so every
 *  request stays well under the serverless timeout. Returns progress. */
export async function runFlyerBatch(ws: WorkspaceRow, opts: { batchSize?: number; timeBudgetMs?: number } = {}): Promise<BatchResult> {
  const svc = createServiceClient();
  const { data: gRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = ((gRow?.goals as Record<string, unknown>) ?? {});
  const job = goals.flyerJob as FlyerJob | undefined;
  if (!job || job.status !== "running") return { status: "idle", processed: job?.cursor ?? 0, total: job?.total ?? 0, flyersRead: job?.flyersRead ?? 0, deals: ((goals.flyerDeals as FlyerReport | undefined)?.deals?.length) ?? 0 };

  const batchSize = opts.batchSize ?? 2;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 95000);
  const slice = job.profiles.slice(job.cursor, job.cursor + batchSize);

  const retentionDays = retentionDaysForPlan(await planOfOrg(job.orgId));
  // capture followers FIRST (self-commits its own update) so they persist even if
  // the heavier image scrape below times out
  if (job.cursor === 0) { try { await captureFollowers(ws, svc, retentionDays); } catch { /* followers are best-effort */ } }

  const ownFlyers: Flyer[] = [], rivalFlyers: Flyer[] = [];
  let costUsd = job.costUsd;
  let done = 0;
  for (const t of slice) {
    if (Date.now() > deadline) break;
    const r = await scrapeProfileFlyers(ws, svc, t, 4);
    (t.own ? ownFlyers : rivalFlyers).push(...r.flyers);
    costUsd += r.costUsd;
    done++;
  }
  const rivalRes = rivalFlyers.length ? await visionExtract(ws, rivalFlyers) : { deals: [], visuals: [] };
  const ownRes = ownFlyers.length ? await visionExtract(ws, ownFlyers) : { deals: [], visuals: [] };
  const rivalFresh = rivalRes.deals, ownFresh = ownRes.deals;

  // merge into rivals' vs owner's caches separately + advance the job
  const now = new Date().toISOString();
  const prevRival = (goals.flyerDeals as FlyerReport | undefined) ?? { deals: [], flyersRead: 0, at: now };
  const prevOwn = (goals.myFlyerDeals as FlyerReport | undefined) ?? { deals: [], flyersRead: 0, at: now };
  const mergedRival = mergeDeals(prevRival.deals ?? [], rivalFresh, now, retentionDays);
  const mergedOwn = mergeDeals(prevOwn.deals ?? [], ownFresh, now, retentionDays);
  const mergedVisuals = mergeVisuals(goals.visuals as VisualsReport | undefined, [...rivalRes.visuals, ...ownRes.visuals], ws.name, now);
  const cursor = job.cursor + done;
  const flyersRead = job.flyersRead + ownFlyers.length + rivalFlyers.length;
  const finished = cursor >= job.total || done === 0;

  const nextJob: FlyerJob = { ...job, cursor, flyersRead, dealsFound: mergedRival.length, costUsd: Number(costUsd.toFixed(4)), updatedAt: now, status: finished ? "done" : "running" };
  const rivalReport: FlyerReport = { deals: mergedRival, flyersRead, at: now, ...(mergedRival.length ? {} : { empty: true }) };
  const ownReport: FlyerReport = { deals: mergedOwn, flyersRead: (prevOwn.flyersRead ?? 0) + ownFlyers.length, at: now, ...(mergedOwn.length ? {} : { empty: true }) };
  // re-read goals just before writing so captureFollowers' socialTimeline isn't clobbered
  const { data: freshRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const writeGoals = ((freshRow?.goals as Record<string, unknown>) ?? goals);
  await svc.from("workspace").update({ goals: { ...writeGoals, flyerDeals: rivalReport, myFlyerDeals: ownReport, visuals: mergedVisuals, flyerJob: nextJob } }).eq("id", ws.id);

  // refund if the whole run turned up no flyer images at all
  if (finished && flyersRead === 0 && job.charged > 0) {
    await refundCredits(job.orgId, job.charged, "flyer_read_refund", { workspaceId: ws.id });
  }
  return { status: finished ? "done" : "running", processed: cursor, total: job.total, flyersRead, deals: mergedRival.length };
}

/** Read the cached flyer deals (never scrapes). */
export async function getFlyerDeals(ws: WorkspaceRow): Promise<FlyerReport> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  return ((data?.goals as { flyerDeals?: FlyerReport } | null)?.flyerDeals) ?? { deals: [], flyersRead: 0, at: new Date().toISOString(), empty: true };
}

/** One-shot flyer read for the WORKER cron path (bounded, synchronous). Kept for
 *  server-side batch jobs; the owner-facing path uses the async job above. */
export async function refreshFlyers(
  ws: WorkspaceRow,
  opts: { maxCompetitors?: number; postsPerCompetitor?: number } = {},
): Promise<{ activated: boolean; flyers: number; deals: number; costUsd: number }> {
  if (!flyersConfigured()) return { activated: false, flyers: 0, deals: 0, costUsd: 0 };
  const svc = createServiceClient();
  await ensureBucket(svc);
  const max = opts.maxCompetitors ?? 6;
  const [ownProfiles, rivalProfiles] = await Promise.all([resolveOwnProfiles(ws, svc), resolveFlyerProfiles(ws, svc, max)]);
  if (!rivalProfiles.length && !ownProfiles.length) return { activated: true, flyers: 0, deals: 0, costUsd: 0 };

  const { data: gRow } = await svc.from("workspace").select("goals, organization_id").eq("id", ws.id).maybeSingle();
  const goals = ((gRow?.goals as Record<string, unknown>) ?? {});
  const retentionDays = retentionDaysForPlan(await planOfOrg((gRow as any)?.organization_id));
  // capture followers first (self-commits) so they persist regardless of the scrape
  try { await captureFollowers(ws, svc, retentionDays); } catch { /* followers are best-effort */ }
  const prevRival = (goals.flyerDeals as FlyerReport | undefined) ?? { deals: [], flyersRead: 0, at: "" };
  const prevOwn = (goals.myFlyerDeals as FlyerReport | undefined) ?? { deals: [], flyersRead: 0, at: "" };
  const cursor = Number((goals as any).flyerCursor ?? 0) || 0;
  const start = rivalProfiles.length ? cursor % rivalProfiles.length : 0;
  const rotatedRivals = [...rivalProfiles.slice(start), ...rivalProfiles.slice(0, start)].slice(0, max);
  // own profiles always read (few, cheap) so owner prices refresh every run
  const scrapeList = [...ownProfiles, ...rotatedRivals];

  const ownFlyers: Flyer[] = [], rivalFlyers: Flyer[] = [];
  let costUsd = 0; let rivalScraped = 0;
  const hardStop = Date.now() + 230000;
  for (const t of scrapeList) {
    if (Date.now() > hardStop) break;
    const r = await scrapeProfileFlyers(ws, svc, t, opts.postsPerCompetitor ?? 4);
    (t.own ? ownFlyers : rivalFlyers).push(...r.flyers); costUsd += r.costUsd;
    if (!t.own) rivalScraped++;
  }
  const rivalRes = rivalFlyers.length ? await visionExtract(ws, rivalFlyers) : { deals: [], visuals: [] };
  const ownRes = ownFlyers.length ? await visionExtract(ws, ownFlyers) : { deals: [], visuals: [] };
  const rivalFresh = rivalRes.deals, ownFresh = ownRes.deals;
  const now = new Date().toISOString();
  const mergedRival = mergeDeals(prevRival.deals ?? [], rivalFresh, now, retentionDays);
  const mergedOwn = mergeDeals(prevOwn.deals ?? [], ownFresh, now, retentionDays);
  const mergedVisuals = mergeVisuals(goals.visuals as VisualsReport | undefined, [...rivalRes.visuals, ...ownRes.visuals], ws.name, now);
  const nextCursor = rivalProfiles.length ? (start + rivalScraped) % rivalProfiles.length : 0;
  const rivalReport: FlyerReport = { deals: mergedRival, flyersRead: rivalFlyers.length, at: now, ...(mergedRival.length ? {} : { empty: true }) };
  const ownReport: FlyerReport = { deals: mergedOwn, flyersRead: (prevOwn.flyersRead ?? 0) + ownFlyers.length, at: now, ...(mergedOwn.length ? {} : { empty: true }) };
  // re-read goals so captureFollowers' socialTimeline (committed above) isn't clobbered
  const { data: freshRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const writeGoals = ((freshRow?.goals as Record<string, unknown>) ?? goals);
  await svc.from("workspace").update({ goals: { ...writeGoals, flyerDeals: rivalReport, myFlyerDeals: ownReport, visuals: mergedVisuals, flyerCursor: nextCursor } }).eq("id", ws.id);
  return { activated: true, flyers: rivalFlyers.length + ownFlyers.length, deals: rivalFresh.length + ownFresh.length, costUsd: Number(costUsd.toFixed(4)) };
}
