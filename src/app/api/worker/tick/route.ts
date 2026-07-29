import { NextResponse } from "next/server";
import { processOneJob } from "@/lib/jobs";

/**
 * Worker tick — claims and processes ONE collection job. Secret-gated (system
 * endpoint, not user auth). Driven locally by `npm run worker`; in production by
 * a scheduled trigger (e.g. Vercel Cron) hitting this repeatedly.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300; // one business crawl+extract fits comfortably

export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await processOneJob();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
