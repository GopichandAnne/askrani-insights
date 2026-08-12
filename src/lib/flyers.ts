import { createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { collectApifyPlatform, apifyConfigured } from "@/lib/providers/apify/platforms";

/**
 * Flyer deal extraction — the grocery goldmine. Groceries post their weekly SALES
 * as flyer/poster IMAGES (prices live in the image, not the caption), and the
 * scraped CDN urls 403 once their signature expires. So we scrape competitors'
 * social FRESH, immediately download the flyer images to Supabase Storage (public
 * bucket), then VISION-extract the sale items + prices from the stored posters.
 * Cost-bearing (Apify scrape + storage + vision) → gated + on-demand, never on a
 * cron. Result cached on workspace.goals.flyerDeals.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const BUCKET = "flyers";

export interface FlyerDeal { rival: string; item: string; price?: string; terms?: string; imageUrl?: string; postUrl?: string; source?: string }
export interface FlyerReport { deals: FlyerDeal[]; flyersRead: number; at: string; empty?: boolean }

export function flyersConfigured(): boolean {
  return apifyConfigured() && isLlmConfigured();
}

async function ensureBucket(svc: ReturnType<typeof createServiceClient>) {
  try { await svc.storage.createBucket(BUCKET, { public: true }); } catch { /* already exists */ }
}

// tiny stable-ish key from a string (no Math.random needed)
function keyOf(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// Download the fresh image, store it, AND keep the bytes as base64 — Anthropic
// vision reads base64 reliably (a URL source silently returned nothing).
async function storeImage(
  svc: ReturnType<typeof createServiceClient>, url: string, key: string,
): Promise<{ publicUrl: string; base64: string; mediaType: string } | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "image/*,*/*", referer: "https://www.instagram.com/" } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) return null; // skip tiny/placeholder
    const path = `${key}.jpg`;
    const { error } = await svc.storage.from(BUCKET).upload(path, buf, { contentType: ct, upsert: true });
    if (error) return null;
    return { publicUrl: svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, base64: buf.toString("base64"), mediaType: ct };
  } catch {
    return null;
  }
}

// Nested per-image structure (one entry per image, each with its own deals) —
// the model fills this reliably; a flat imageIndex+deal array tended to come back
// empty on multi-image calls.
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

/** Scrape competitors fresh, store their flyer images, and vision-extract deals.
 *  opts.igUrls overrides the competitor IG list (used for targeted verification). */
export async function refreshFlyers(
  ws: WorkspaceRow,
  opts: { maxCompetitors?: number; postsPerCompetitor?: number; igUrls?: { url: string; rival: string }[] } = {},
): Promise<{ activated: boolean; flyers: number; deals: number; costUsd: number }> {
  if (!flyersConfigured()) return { activated: false, flyers: 0, deals: 0, costUsd: 0 };
  const svc = createServiceClient();
  await ensureBucket(svc);

  // resolve which profiles to scrape — competitors' Instagram AND Facebook pages
  const maxComp = opts.maxCompetitors ?? 6;
  const targets: { url: string; rival: string; platform: string }[] =
    opts.igUrls?.map((t) => ({ ...t, platform: "instagram" })) ?? (await (async () => {
      const ids = await workspaceBusinessIds(ws, svc as any);
      const compIds = ids.competitorIds.slice(0, maxComp);
      const [{ data: biz }, { data: idents }] = await Promise.all([
        svc.from("business").select("id, canonical_name").in("id", compIds),
        svc.from("external_identity").select("business_id, url, platform").in("platform", ["instagram", "facebook"]).in("business_id", compIds),
      ]);
      const nameById = new Map((biz ?? []).map((b: any) => [b.id as string, b.canonical_name as string]));
      return (idents ?? []).map((r: any) => ({ url: r.url as string, rival: nameById.get(r.business_id) ?? "A rival", platform: r.platform as string }));
    })());
  if (!targets.length) return { activated: true, flyers: 0, deals: 0, costUsd: 0 };

  // scrape fresh + download images immediately (fresh CDN signatures are valid).
  // Cap total profiles so cost stays bounded even when rivals have IG *and* FB.
  const flyers: { rival: string; caption: string; postUrl?: string; storedUrl: string; base64: string; mediaType: string; source: string }[] = [];
  let costUsd = 0;
  const per = opts.postsPerCompetitor ?? 4;
  for (const t of targets.slice(0, maxComp * 2)) {
    const { items, costUsd: c } = await collectApifyPlatform(t.platform, t.url, { maxMs: 90000 });
    costUsd += c;
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
  }
  if (!flyers.length) return { activated: true, flyers: 0, deals: 0, costUsd: Number(costUsd.toFixed(4)) };

  // vision-extract deals from stored flyer images, in batches
  const deals: FlyerDeal[] = [];
  const BATCH = 6;
  for (let i = 0; i < flyers.length; i += BATCH) {
    const batch = flyers.slice(i, i + BATCH);
    try {
      const { data } = await getLlm().callStructured<{ images: { imageIndex: number; deals: { item: string; price?: string; terms?: string }[] }[] }>({
        system: VISION_SYSTEM,
        text: `These are ${batch.length} flyer/promo images from local ${ws.vertical} businesses, in order [0..${batch.length - 1}]. For each image, extract the sale items + prices printed on it.`,
        images: batch.map((f) => ({ base64: f.base64, mediaType: f.mediaType })),
        schema: VISION_SCHEMA,
        tier: "extract",
        maxTokens: 2200,
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

  const report: FlyerReport = { deals: deals.slice(0, 40), flyersRead: flyers.length, at: new Date().toISOString(), ...(deals.length ? {} : { empty: true }) };
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), flyerDeals: report } }).eq("id", ws.id);
  return { activated: true, flyers: flyers.length, deals: deals.length, costUsd: Number(costUsd.toFixed(4)) };
}

/** Read the cached flyer deals (populated by the gated refresh; never scrapes). */
export async function getFlyerDeals(ws: WorkspaceRow): Promise<FlyerReport> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  return ((data?.goals as { flyerDeals?: FlyerReport } | null)?.flyerDeals) ?? { deals: [], flyersRead: 0, at: new Date().toISOString(), empty: true };
}
