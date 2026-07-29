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

interface PlatformConfig {
  actor: () => string | undefined; // undefined = not configured → skip
  input: (target: string) => Record<string, unknown>;
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
  doordash: {
    actor: () => env("APIFY_DOORDASH_ACTOR"),
    input: (t) => ({ startUrls: [{ url: t }] }),
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "menu",
    platform: "doordash",
  },
  ubereats: {
    actor: () => env("APIFY_UBEREATS_ACTOR"),
    input: (t) => ({ startUrls: [{ url: t }] }),
    provenance: "MANAGED_PUBLIC_PROVIDER_APIFY",
    contentKind: "menu",
    platform: "ubereats",
  },
};

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
 * Run the platform's Actor for one target (profile/page/store URL) and return
 * normalized observations. Returns [] (never throws) when not configured, so the
 * collection worker degrades cleanly.
 */
export async function collectApifyPlatform(
  platform: string,
  target: string,
  opts: { maxMs?: number } = {},
): Promise<RawObservation[]> {
  const token = process.env.APIFY_TOKEN;
  const cfg = CONFIG[platform];
  if (!token || !cfg) return [];
  const actor = cfg.actor();
  if (!actor) return []; // no Actor configured for this platform

  const maxMs = opts.maxMs ?? 75000;
  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg.input(target)),
    });
    if (!runRes.ok) return [];
    const run = (await runRes.json()) as any;
    const runId = run.data?.id;
    if (!runId) return [];

    const deadline = Date.now() + maxMs;
    let datasetId: string | undefined;
    while (Date.now() < deadline) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json() as any);
      const s = st.data?.status;
      if (s === "SUCCEEDED") {
        datasetId = st.data?.defaultDatasetId;
        break;
      }
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return [];
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!datasetId) return []; // still running past our budget — skip this pass

    const items = (await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true`,
    ).then((r) => r.json())) as any[];
    return items.map((it) => mapItem(cfg, it));
  } catch {
    return [];
  }
}

export const APIFY_PLATFORMS = Object.keys(CONFIG);
