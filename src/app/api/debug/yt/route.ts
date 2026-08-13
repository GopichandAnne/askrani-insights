import { NextResponse } from "next/server";
import { youtubeChannelStats } from "@/lib/providers/youtube";

/** Worker-secret debug: resolve a YouTube channel URL/handle to its stats, to
 *  verify subscriber capture in isolation (no flyer scan). GET ?url=... */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("secret") !== process.env.WORKER_SECRET) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = u.searchParams.get("url") ?? "";
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });
  const configured = !!process.env.YOUTUBE_API_KEY;
  const stats = await youtubeChannelStats(url);
  return NextResponse.json({ configured, url, stats });
}
