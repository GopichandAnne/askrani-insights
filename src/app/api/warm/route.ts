import { NextResponse } from "next/server";
import { warmWorkspaceSynthesis } from "@/lib/warm";

/**
 * Warm a workspace's synthesis caches (briefing/edge/trends/news) in its OWN
 * function invocation, so it gets the full time budget instead of sharing the
 * collection worker's. Kicked (fire-and-forget) from the job drain hook once a
 * workspace's collection finishes. Authenticated with the shared WORKER_SECRET
 * (or the Vercel Cron header), never by a user.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const cron = process.env.CRON_SECRET;
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (worker && provided === worker) return true;
  if (cron && req.headers.get("authorization") === `Bearer ${cron}`) return true;
  if (cron && req.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await req.json().catch(() => ({}));
  if (!workspaceId || typeof workspaceId !== "string") {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  try {
    await warmWorkspaceSynthesis(workspaceId);
    return NextResponse.json({ warmed: true, workspaceId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
