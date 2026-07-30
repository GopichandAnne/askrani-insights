import { NextResponse } from "next/server";
import { processOneJob } from "@/lib/jobs";

/**
 * Worker tick — drains the collection queue.
 *
 * POST: used by the local worker (`npm run worker`), authenticated with the
 *   shared WORKER_SECRET header; processes ONE job.
 * GET:  used by Vercel Cron in production, authenticated via the
 *   `Authorization: Bearer $CRON_SECRET` header Vercel sends; drains a BATCH of
 *   jobs within a time budget so a once-a-minute cron keeps up.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const cron = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (worker && provided === worker) return true; // local worker
  if (cron && auth === `Bearer ${cron}`) return true; // Vercel Cron
  // Vercel also sets this header on cron invocations
  if (cron && req.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await processOneJob());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Drain a batch, bounded by wall-clock so we stay under the function limit.
  const budgetMs = 240_000;
  const started = Date.now();
  let processed = 0;
  let remaining = 0;
  try {
    while (Date.now() - started < budgetMs) {
      const r = await processOneJob();
      remaining = r.remaining;
      if (!r.processed) break; // queue empty
      processed++;
    }
    return NextResponse.json({ processed, remaining });
  } catch (e) {
    return NextResponse.json({ processed, error: (e as Error).message }, { status: 500 });
  }
}
