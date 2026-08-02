import { NextResponse } from "next/server";
import { exploreArea } from "@/lib/explore";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** No-setup area market scan: {area, keyword} → ranked businesses with ratings.
 *  PUBLIC — powers the signed-out landing demo (read-only public data), so anyone
 *  can size up an area before signing up. Guard inputs to bound cost/abuse. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const area = String(body.area ?? "").trim().slice(0, 80);
  const keyword = String(body.keyword ?? "").trim().slice(0, 60);
  if (area.length < 2) return NextResponse.json({ results: [], error: "Enter a zip code or city." });
  const data = await exploreArea({ area, keyword });
  return NextResponse.json(data);
}
