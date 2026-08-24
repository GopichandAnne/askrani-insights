import { NextResponse } from "next/server";
import { canManageBusiness } from "@/lib/channels";
import { collectBusiness, type CollectResult } from "@/lib/collect";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// Channels the owner can refresh on demand. Uses collectBusiness's `only` filter
// to re-scrape exactly ONE source, so an owner who just updated their Instagram
// (or a delivery menu) can pull it now without waiting for a full workspace scan.
const ALLOWED = new Set(["instagram", "facebook", "tiktok", "youtube", "doordash", "ubereats", "website", "google", "yelp"]);

export async function POST(req: Request) {
  const { businessId, platform } = await req.json().catch(() => ({}));
  if (!businessId || !platform) return NextResponse.json({ error: "businessId and platform required" }, { status: 400 });
  if (!ALLOWED.has(platform)) return NextResponse.json({ error: "unsupported channel" }, { status: 400 });
  if (!(await canManageBusiness(businessId))) return NextResponse.json({ error: "not allowed" }, { status: 403 });

  // Scrape just this one source (dedup + auto-prune still apply). force bypasses
  // the freshness-reuse guard — an on-demand refresh should always re-scrape.
  // budgetMs keeps us inside the function limit for a slow crawl.
  const res = await collectBusiness(businessId, { only: [platform], force: true, budgetMs: 150_000 });
  return NextResponse.json({
    ok: res.ok,
    platform,
    collected: { posts: res.socialPosts, offers: res.offersWritten, reviews: res.reviews, pages: res.pagesFetched },
    message: res.ok ? summarize(platform, res) : (res.error ?? "Couldn’t refresh right now — try again in a moment."),
  });
}

function summarize(platform: string, res: CollectResult): string {
  const parts: string[] = [];
  if (res.socialPosts) parts.push(`${res.socialPosts} post${res.socialPosts === 1 ? "" : "s"}`);
  if (res.offersWritten) parts.push(`${res.offersWritten} item${res.offersWritten === 1 ? "" : "s"}`);
  if (res.reviews) parts.push(`${res.reviews} review${res.reviews === 1 ? "" : "s"}`);
  if (res.pagesFetched && platform === "website") parts.push(`${res.pagesFetched} page${res.pagesFetched === 1 ? "" : "s"}`);
  return parts.length ? `Refreshed — pulled ${parts.join(", ")}.` : "Refreshed — nothing new found this time.";
}
