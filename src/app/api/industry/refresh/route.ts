import { NextResponse } from "next/server";
import { refreshIndustryCorpus } from "@/lib/industry";
import { hashtagActorConfigured } from "@/lib/providers/apify/platforms";

/**
 * Refresh the national industry corpus for a vertical (+optional subtype) by
 * scraping the top posts under its hashtags. COST-BEARING (Apify) and shared
 * across all workspaces of that vertical, so it's:
 *   • gated — dormant (200 {activated:false}) unless APIFY_TOKEN is set;
 *   • WORKER_SECRET-only — never user-triggered, never on a cron (spend is manual).
 * POST { vertical, subtype?: string[], limitPerTag?, maxTags? }.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  return !!worker && provided === worker;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hashtagActorConfigured()) {
    return NextResponse.json({ activated: false, reason: "Set APIFY_TOKEN (and optionally APIFY_INSTAGRAM_HASHTAG_ACTOR) to enable." });
  }
  const body = await req.json().catch(() => ({}));
  // Any vertical is allowed — the curated ones use tuned hashtags, the rest get
  // LLM-derived ones (cached). Just guard against an empty/garbage value.
  const vertical = String(body.vertical ?? "").trim().toLowerCase().slice(0, 40);
  if (!/^[a-z_]{2,}$/.test(vertical)) {
    return NextResponse.json({ error: "vertical required (e.g. restaurant, fitness, dental, real_estate…)" }, { status: 400 });
  }
  const subtype: string[] = Array.isArray(body.subtype) ? body.subtype.map(String) : [];
  try {
    const result = await refreshIndustryCorpus(vertical, subtype, {
      limitPerTag: Number(body.limitPerTag) || undefined,
      maxTags: Number(body.maxTags) || undefined,
    });
    return NextResponse.json({ ...result, plannedTags: result.tags });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
