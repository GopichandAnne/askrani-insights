import { NextResponse } from "next/server";
import { refreshIndustryCorpus, industryHashtags } from "@/lib/industry";
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
  const vertical = String(body.vertical ?? "").trim();
  if (!["restaurant", "salon", "grocery"].includes(vertical)) {
    return NextResponse.json({ error: "vertical must be restaurant | salon | grocery" }, { status: 400 });
  }
  const subtype: string[] = Array.isArray(body.subtype) ? body.subtype.map(String) : [];
  try {
    const result = await refreshIndustryCorpus(vertical, subtype, {
      limitPerTag: Number(body.limitPerTag) || undefined,
      maxTags: Number(body.maxTags) || undefined,
    });
    return NextResponse.json({ ...result, plannedTags: industryHashtags(vertical, subtype) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
