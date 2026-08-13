import {
  PublicContentProvider,
  DiscoverInput,
  ProfileBatch,
  ContentBatch,
  ProviderJob,
  ProviderJobStatus,
  ProviderHealth,
  ProviderRequest,
  CostEstimate,
  ProfileCandidate,
  RawObservation,
  ProviderNotConfigured,
  UnsupportedCapability,
} from "../types";
import { createHash } from "node:crypto";

// ── Standalone helpers (no provider instance) for channel stats — used by the
// social signals layer to bank YouTube subscribers on the follower timeline.
const YT_KEY = () => process.env.YOUTUBE_API_KEY ?? "";
function ytApi(path: string, params: Record<string, string>) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", YT_KEY());
  return fetch(u);
}
async function ytResolveChannelId(ref: string): Promise<string | undefined> {
  if (/^UC[\w-]{20,}$/.test(ref)) return ref;
  const idMatch = ref.match(/channel\/(UC[\w-]+)/);
  if (idMatch) return idMatch[1];
  const handleMatch = ref.match(/@([A-Za-z0-9._-]+)/);
  if (handleMatch) {
    const res = await ytApi("channels", { part: "id", forHandle: `@${handleMatch[1]}` });
    return ((await res.json()) as any).items?.[0]?.id;
  }
  const res = await ytApi("search", { part: "snippet", type: "channel", q: ref, maxResults: "1" });
  return ((await res.json()) as any).items?.[0]?.snippet?.channelId;
}
const ytNum = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : undefined; };

/** Channel stats via the YouTube Data API (subscribers/videos/total views). */
export async function youtubeChannelStats(ref: string): Promise<{ subscribers?: number; videos?: number; views?: number }> {
  if (!YT_KEY() || !ref) return {};
  try {
    const id = await ytResolveChannelId(ref);
    if (!id) return {};
    const res = await ytApi("channels", { part: "statistics", id });
    const st = ((await res.json()) as any).items?.[0]?.statistics ?? {};
    return { subscribers: ytNum(st.subscriberCount), videos: ytNum(st.videoCount), views: ytNum(st.viewCount) };
  } catch { return {}; }
}

/**
 * YouTube adapter — official Data API v3 (clean, free quota). Discovers channels
 * and collects a channel's recent uploads (title + description) as content the
 * extraction pipeline can mine for offers/announcements. Activates with
 * YOUTUBE_API_KEY. Video frame/transcript analysis (guide §6.2) is not built —
 * we use titles/descriptions/captions text only.
 */
export class YouTubeProvider implements PublicContentProvider {
  readonly name = "youtube";
  readonly provenance = "OFFICIAL_PUBLIC_API" as const;

  private jobs = new Map<string, { status: ProviderJobStatus; results: RawObservation[] }>();
  private get key() {
    return process.env.YOUTUBE_API_KEY ?? "";
  }
  isConfigured(): boolean {
    return this.key.length > 0;
  }
  private assert() {
    if (!this.isConfigured()) throw new ProviderNotConfigured(this.name, "YOUTUBE_API_KEY");
  }
  private api(path: string, params: Record<string, string>) {
    const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("key", this.key);
    return fetch(u);
  }

  async discoverProfiles(input: DiscoverInput): Promise<ProfileCandidate[]> {
    this.assert();
    const res = await this.api("search", {
      part: "snippet",
      type: "channel",
      q: input.query ?? "",
      maxResults: String(Math.min(input.limit ?? 5, 10)),
    });
    if (!res.ok) throw new Error(`youtube search ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return (data.items ?? []).map((it: any): ProfileCandidate => ({
      name: it.snippet?.channelTitle ?? it.snippet?.title ?? "",
      platform: "youtube",
      externalId: it.snippet?.channelId ?? it.id?.channelId,
      url: `https://www.youtube.com/channel/${it.snippet?.channelId ?? it.id?.channelId}`,
      confidence: 0.6,
      raw: it,
    }));
  }

  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectProfiles");
  }

  /** input.urls carries channel ids, @handles, or channel URLs. */
  async collectContent(input: ContentBatch): Promise<ProviderJob> {
    this.assert();
    const jobId = `youtube_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    this.jobs.set(jobId, { status: { jobId, provider: this.name, status: "running" }, results: [] });

    (async () => {
      const out: RawObservation[] = [];
      const errors: string[] = [];
      const now = new Date().toISOString();
      for (const ref of input.urls) {
        try {
          const channelId = await this.resolveChannelId(ref);
          if (!channelId) {
            errors.push(`${ref}: channel not found`);
            continue;
          }
          const chRes = await this.api("channels", { part: "contentDetails", id: channelId });
          const ch = (await chRes.json()) as any;
          const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
          if (!uploads) continue;
          const plRes = await this.api("playlistItems", {
            part: "snippet",
            playlistId: uploads,
            maxResults: String(input.resultsLimit ?? 12),
          });
          const pl = (await plRes.json()) as any;
          // fetch per-video statistics (views/likes/comments) in one batched call
          const vids: string[] = (pl.items ?? []).map((it: any) => it.snippet?.resourceId?.videoId).filter(Boolean);
          const statsById = new Map<string, any>();
          if (vids.length) {
            const vRes = await this.api("videos", { part: "statistics", id: vids.slice(0, 50).join(",") });
            const vData = (await vRes.json()) as any;
            for (const v of vData.items ?? []) statsById.set(v.id, v.statistics ?? {});
          }
          for (const it of pl.items ?? []) {
            const s = it.snippet ?? {};
            const videoId = s.resourceId?.videoId;
            const text = [s.title, s.description].filter(Boolean).join("\n");
            const media: RawObservation["media"] = [];
            if (s.thumbnails?.high?.url) media.push({ type: "image", url: s.thumbnails.high.url });
            const st = statsById.get(videoId) ?? {};
            const likes = ytNum(st.likeCount), comments = ytNum(st.commentCount), views = ytNum(st.viewCount);
            if (likes != null || comments != null || views != null) media.push({ type: "metrics", likes, comments, views } as any);
            out.push({
              provider: this.name,
              provenance: "OFFICIAL_PUBLIC_API",
              platform: "youtube",
              contentKind: "post",
              externalRef: videoId,
              sourceUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
              text,
              media,
              publishedAt: s.publishedAt,
              observedAt: now,
              contentHash: createHash("sha256").update(`${videoId}|${text}`).digest("hex"),
              raw: it,
            });
          }
        } catch (e) {
          errors.push(`${ref}: ${(e as Error).message}`);
        }
      }
      const job = this.jobs.get(jobId)!;
      job.results = out;
      job.status = {
        jobId,
        provider: this.name,
        status: out.length ? "succeeded" : errors.length ? "failed" : "partial",
        resultCount: out.length,
        error: errors.length ? errors.slice(0, 5).join("; ") : undefined,
      };
    })();

    return { jobId, provider: this.name, status: "running", submittedAt: new Date().toISOString() };
  }

  private async resolveChannelId(ref: string): Promise<string | undefined> {
    if (/^UC[\w-]{20,}$/.test(ref)) return ref; // already a channel id
    // handle or URL → extract @handle or channel id
    const handleMatch = ref.match(/@([A-Za-z0-9._-]+)/);
    const idMatch = ref.match(/channel\/(UC[\w-]+)/);
    if (idMatch) return idMatch[1];
    if (handleMatch) {
      const res = await this.api("channels", { part: "id", forHandle: `@${handleMatch[1]}` });
      const data = (await res.json()) as any;
      return data.items?.[0]?.id;
    }
    // fallback: search by the raw ref
    const res = await this.api("search", { part: "snippet", type: "channel", q: ref, maxResults: "1" });
    const data = (await res.json()) as any;
    return data.items?.[0]?.snippet?.channelId;
  }

  async getJob(jobId: string): Promise<ProviderJobStatus> {
    return this.jobs.get(jobId)?.status ?? { jobId, provider: this.name, status: "failed", error: "unknown job" };
  }
  async *fetchResults(jobId: string): AsyncIterable<RawObservation> {
    for (const obs of this.jobs.get(jobId)?.results ?? []) yield obs;
  }
  async estimateCost(_i: ProviderRequest): Promise<CostEstimate> {
    return { provider: this.name, currency: "USD", estimatedUsd: 0, basis: "YouTube Data API free quota (10k units/day)" };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      ok: this.isConfigured(),
      configured: this.isConfigured(),
      detail: this.isConfigured() ? undefined : "YOUTUBE_API_KEY not set",
      checkedAt: new Date().toISOString(),
    };
  }
}
