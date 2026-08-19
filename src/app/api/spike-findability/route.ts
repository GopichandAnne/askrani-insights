import { NextResponse } from "next/server";
import { getProvider } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEMPORARY data-source spike for the Findability feature. Validates that Google
 * Places text-search returns a clean, STABLE, per-keyword rank order we can read
 * positions off of (index = search rank). WORKER_SECRET gated, read-only. Remove
 * after validation. POST { keywords: string[], near?: {lat,lng,radiusKm} }.
 */
export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET;
  if (!secret || req.headers.get("x-worker-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const keywords: string[] = Array.isArray(body.keywords) ? body.keywords.map(String).slice(0, 8) : [];
  const near = body.near && typeof body.near.lat === "number" ? body.near : undefined;
  if (!keywords.length) return NextResponse.json({ error: "keywords[] required" }, { status: 400 });

  const google = getProvider("google");
  if (!google?.isConfigured()) return NextResponse.json({ error: "google not configured" }, { status: 500 });

  const rankOnce = async (kw: string) => {
    const cands = await google.discoverProfiles({ query: kw, near, limit: 20 });
    return cands.map((c, i) => ({
      rank: i + 1,
      name: c.name,
      rating: (c.raw as { rating?: number } | undefined)?.rating ?? null,
      reviews: (c.raw as { userRatingCount?: number } | undefined)?.userRatingCount ?? null,
    }));
  };

  const out = [];
  for (const kw of keywords) {
    const a = await rankOnce(kw);
    const b = await rankOnce(kw); // repeat → is the order stable?
    const stable = JSON.stringify(a.map((x) => x.name)) === JSON.stringify(b.map((x) => x.name));
    out.push({ keyword: kw, count: a.length, stable, top: a.slice(0, 12) });
  }
  return NextResponse.json({ ok: true, results: out });
}
