import { createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { collectApifyPlatform, apifyConfigured } from "@/lib/providers/apify/platforms";
import { refundCredits } from "@/lib/credits";

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

export interface FlyerDeal { rival: string; item: string; price?: string; terms?: string; imageUrl?: string; postUrl?: string; source?: string }
export interface FlyerReport { deals: FlyerDeal[]; flyersRead: number; at: string; empty?: boolean }
export interface FlyerProfile { url: string; rival: string; platform: string }
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

interface Flyer { rival: string; caption: string; postUrl?: string; storedUrl: string; base64: string; mediaType: string; source: string }

export function flyersConfigured(): boolean {
  return apifyConfigured() && isLlmConfigured();
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
          deals: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                item: { type: "string", description: "the product on sale" },
                price: { type: "string", description: "the sale price exactly as printed (e.g. '$0.99/lb', '2 for $5'), or '' if none" },
                terms: { type: "string", description: "terms/validity if shown (e.g. 'thru Sun', 'limit 2'), else ''" },
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
  "You read retail SALE FLYERS / promo posters (grocery, restaurant, spa). For each image, list every product on sale with its price EXACTLY as printed and any terms. Read only what is visibly printed — never guess a price. If an image is a lifestyle/brand photo with no sale prices, return nothing for it.";

/** Competitors' Instagram + Facebook profiles, interleaved so both platforms are sampled. */
export async function resolveFlyerProfiles(ws: WorkspaceRow, svc: Svc, maxCompetitors = 8): Promise<FlyerProfile[]> {
  const ids = await workspaceBusinessIds(ws, svc as any);
  const compIds = ids.competitorIds.slice(0, maxCompetitors);
  if (!compIds.length) return [];
  const [{ data: biz }, { data: idents }] = await Promise.all([
    svc.from("business").select("id, canonical_name").in("id", compIds),
    svc.from("external_identity").select("business_id, url, platform").in("platform", ["instagram", "facebook"]).in("business_id", compIds),
  ]);
  const nameById = new Map((biz ?? []).map((b: any) => [b.id as string, b.canonical_name as string]));
  const all: FlyerProfile[] = (idents ?? []).map((r: any) => ({ url: r.url as string, rival: nameById.get(r.business_id) ?? "A rival", platform: r.platform as string }));
  const igT = all.filter((t) => t.platform === "instagram");
  const fbT = all.filter((t) => t.platform === "facebook");
  const ordered: FlyerProfile[] = [];
  for (let i = 0; i < Math.max(igT.length, fbT.length); i++) { if (igT[i]) ordered.push(igT[i]); if (fbT[i]) ordered.push(fbT[i]); }
  return ordered;
}

async function scrapeProfileFlyers(ws: WorkspaceRow, svc: Svc, t: FlyerProfile, per: number): Promise<{ flyers: Flyer[]; costUsd: number }> {
  const { items, costUsd } = await collectApifyPlatform(t.platform, t.url, { maxMs: 45000 });
  const flyers: Flyer[] = [];
  let n = 0;
  for (const it of items) {
    if (n >= per) break;
    const imgUrl = (it.media ?? []).find((m) => (m as any).type === "image" && (m as any).url) as any;
    if (!imgUrl?.url) continue;
    const stored = await storeImage(svc, imgUrl.url, `${ws.id}/${keyOf(t.rival + imgUrl.url)}`);
    if (!stored) continue;
    flyers.push({ rival: t.rival, caption: String(it.text ?? "").slice(0, 200), postUrl: (it as any).sourceUrl, storedUrl: stored.publicUrl, base64: stored.base64, mediaType: stored.mediaType, source: t.platform });
    n++;
  }
  return { flyers, costUsd };
}

async function visionExtract(ws: WorkspaceRow, flyers: Flyer[]): Promise<FlyerDeal[]> {
  const deals: FlyerDeal[] = [];
  const BATCH = 6;
  for (let i = 0; i < flyers.length; i += BATCH) {
    const batch = flyers.slice(i, i + BATCH);
    try {
      const { data } = await getLlm().callStructured<{ images: { imageIndex: number; deals: { item: string; price?: string; terms?: string }[] }[] }>({
        system: VISION_SYSTEM,
        text: `These are ${batch.length} flyer/promo images from local ${ws.vertical} businesses, in order [0..${batch.length - 1}]. For each image, extract the sale items + prices printed on it.`,
        images: batch.map((f) => ({ base64: f.base64, mediaType: f.mediaType })),
        schema: VISION_SCHEMA, tier: "extract", maxTokens: 2200,
      });
      for (const im of Array.isArray(data.images) ? data.images : []) {
        const src = batch[Number(im.imageIndex)];
        if (!src) continue;
        for (const d of Array.isArray(im.deals) ? im.deals : []) {
          const item = String(d.item ?? "").replace(/\s+/g, " ").trim();
          if (!item) continue;
          deals.push({ rival: src.rival, item, price: String(d.price ?? "").trim() || undefined, terms: String(d.terms ?? "").trim() || undefined, imageUrl: src.storedUrl, postUrl: src.postUrl, source: src.source });
        }
      }
    } catch { /* skip this batch */ }
  }
  return deals;
}

function mergeDeals(prev: FlyerDeal[], fresh: FlyerDeal[], cap = 60): FlyerDeal[] {
  const dkey = (d: FlyerDeal) => `${d.rival}|${d.item}|${d.price ?? ""}`.toLowerCase();
  const freshKeys = new Set(fresh.map(dkey));
  return [...fresh, ...prev.filter((d) => !freshKeys.has(dkey(d)))].slice(0, cap);
}

// ── Async job ───────────────────────────────────────────────────────────────

/** Start a flyer read: resolve the profile list and store the job. Charging is
 *  done by the caller (the run route) before enqueuing. */
export async function enqueueFlyerJob(ws: WorkspaceRow, orgId: string, charged: number): Promise<{ total: number }> {
  const svc = createServiceClient();
  await ensureBucket(svc);
  const profiles = await resolveFlyerProfiles(ws, svc);
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

  const flyers: Flyer[] = [];
  let costUsd = job.costUsd;
  let done = 0;
  for (const t of slice) {
    if (Date.now() > deadline) break;
    const r = await scrapeProfileFlyers(ws, svc, t, 4);
    flyers.push(...r.flyers);
    costUsd += r.costUsd;
    done++;
  }
  const freshDeals = flyers.length ? await visionExtract(ws, flyers) : [];

  // merge into cached flyerDeals + advance the job
  const prevReport = (goals.flyerDeals as FlyerReport | undefined) ?? { deals: [], flyersRead: 0, at: new Date().toISOString() };
  const mergedDeals = mergeDeals(prevReport.deals ?? [], freshDeals);
  const cursor = job.cursor + done;
  const flyersRead = job.flyersRead + flyers.length;
  const finished = cursor >= job.total || done === 0;

  const nextJob: FlyerJob = { ...job, cursor, flyersRead, dealsFound: mergedDeals.length, costUsd: Number(costUsd.toFixed(4)), updatedAt: new Date().toISOString(), status: finished ? "done" : "running" };
  const report: FlyerReport = { deals: mergedDeals, flyersRead, at: new Date().toISOString(), ...(mergedDeals.length ? {} : { empty: true }) };
  await svc.from("workspace").update({ goals: { ...goals, flyerDeals: report, flyerJob: nextJob } }).eq("id", ws.id);

  // refund if the whole run turned up no flyer images at all
  if (finished && flyersRead === 0 && job.charged > 0) {
    await refundCredits(job.orgId, job.charged, "flyer_read_refund", { workspaceId: ws.id });
  }
  return { status: finished ? "done" : "running", processed: cursor, total: job.total, flyersRead, deals: mergedDeals.length };
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
  const profiles = await resolveFlyerProfiles(ws, svc, opts.maxCompetitors ?? 6);
  if (!profiles.length) return { activated: true, flyers: 0, deals: 0, costUsd: 0 };

  const { data: gRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = ((gRow?.goals as Record<string, unknown>) ?? {});
  const prevReport = (goals.flyerDeals as FlyerReport | undefined) ?? { deals: [], flyersRead: 0, at: "" };
  const cursor = Number((goals as any).flyerCursor ?? 0) || 0;
  const start = profiles.length ? cursor % profiles.length : 0;
  const rotated = [...profiles.slice(start), ...profiles.slice(0, start)];

  const flyers: Flyer[] = [];
  let costUsd = 0; let scraped = 0;
  const hardStop = Date.now() + 230000;
  for (const t of rotated.slice(0, opts.maxCompetitors ?? 6)) {
    if (Date.now() > hardStop) break;
    const r = await scrapeProfileFlyers(ws, svc, t, opts.postsPerCompetitor ?? 4);
    flyers.push(...r.flyers); costUsd += r.costUsd; scraped++;
  }
  const freshDeals = flyers.length ? await visionExtract(ws, flyers) : [];
  const merged = mergeDeals(prevReport.deals ?? [], freshDeals);
  const nextCursor = profiles.length ? (start + scraped) % profiles.length : 0;
  const report: FlyerReport = { deals: merged, flyersRead: flyers.length, at: new Date().toISOString(), ...(merged.length ? {} : { empty: true }) };
  await svc.from("workspace").update({ goals: { ...goals, flyerDeals: report, flyerCursor: nextCursor } }).eq("id", ws.id);
  return { activated: true, flyers: flyers.length, deals: freshDeals.length, costUsd: Number(costUsd.toFixed(4)) };
}
