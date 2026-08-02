import { NextResponse } from "next/server";
import { runScheduler } from "@/lib/schedule";

/**
 * Cadence scheduler tick — enqueues due workspaces for a refresh. Runs on Vercel
 * Cron (Authorization: Bearer $CRON_SECRET / x-vercel-cron), or locally with the
 * WORKER_SECRET header. Cheap: it only enqueues; the worker does the collecting.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const cron = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (worker && provided === worker) return true;
  if (cron && auth === `Bearer ${cron}`) return true;
  if (cron && req.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runScheduler());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export const POST = GET;
