import { NextResponse } from "next/server";
import { marketRead, type ExploreResult } from "@/lib/explore";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Intelligent market-read for an explored area. PUBLIC (powers the signed-out
 *  landing hook), fed the results the client already has so it never re-scrapes.
 *  Bounded inputs keep cost/abuse in check; one cheap LLM call. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const area = String(body.area ?? "").trim().slice(0, 80);
  const keyword = String(body.keyword ?? "").trim().slice(0, 60);
  const raw = Array.isArray(body.results) ? body.results.slice(0, 25) : [];
  const results: ExploreResult[] = raw.map((r: any) => ({
    name: String(r.name ?? "").slice(0, 120),
    rating: typeof r.rating === "number" ? r.rating : null,
    reviews: typeof r.reviews === "number" ? r.reviews : null,
    subtype: String(r.subtype ?? "").slice(0, 40),
    vertical: String(r.vertical ?? ""),
  }));
  if (!results.length) return NextResponse.json({ error: "no results to read" }, { status: 400 });
  return NextResponse.json(await marketRead({ area, keyword, results }));
}
