import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runFlyerBatch, enqueueFlyerJob, type FlyerJob } from "@/lib/flyers";
import type { WorkspaceRow } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// A flyer read the owner PAID for must finish even if they navigate away — it was
// client-driven (FlyerReadButton ticking /api/flyers/tick), so leaving the page
// stranded the remaining competitors. This cron drives any RUNNING flyer job to
// completion server-side. It only touches jobs that have gone quiet (updatedAt >
// ~2 min) so it never collides with a client still actively ticking.
const STALE_MS = 120_000;
const TOTAL_BUDGET_MS = 250_000;
const MAX_WORKSPACES = 3;

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

// Admin/ops path: enqueue a fresh flyer read for one workspace (runs in prod so
// profiles include Google photos) and drive it to completion in this request; the
// cron sweep finishes anything left. `?enqueue=<workspaceId>`.
async function enqueueAndDrive(workspaceId: string) {
  const svc = createServiceClient();
  const { data: w } = await svc.from("workspace").select("id, name, vertical, target_business_id, organization_id, goals").eq("id", workspaceId).maybeSingle();
  if (!w) return { error: "workspace not found" };
  const ws = { id: w.id, name: w.name, vertical: w.vertical, target_business_id: w.target_business_id, goals: w.goals } as WorkspaceRow;
  const { total } = await enqueueFlyerJob(ws, w.organization_id as string, 0);
  const deadline = Date.now() + 250_000;
  let last;
  for (let i = 0; i < 40 && Date.now() < deadline; i++) {
    last = await runFlyerBatch(ws);
    if (last.status !== "running") break;
  }
  return { enqueued: workspaceId, profiles: total, processed: last?.processed ?? 0, total: last?.total ?? total, deals: last?.deals ?? 0, status: last?.status ?? "?" };
}

async function sweep() {
  const svc = createServiceClient();
  const { data: rows } = await svc
    .from("workspace")
    .select("id, name, vertical, target_business_id, goals")
    .filter("goals->flyerJob->>status", "eq", "running")
    .limit(MAX_WORKSPACES * 2);

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const out: { workspace: string; processed: number; total: number; deals: number; status: string }[] = [];
  let touched = 0;

  for (const w of rows ?? []) {
    if (touched >= MAX_WORKSPACES || Date.now() > deadline) break;
    const job = (w.goals as { flyerJob?: FlyerJob } | null)?.flyerJob;
    if (!job || job.status !== "running") continue;
    // skip jobs a client is actively ticking (recently updated)
    if (job.updatedAt && Date.now() - new Date(job.updatedAt).getTime() < STALE_MS) continue;
    touched++;

    const ws = { id: w.id, name: w.name, vertical: w.vertical, target_business_id: w.target_business_id, goals: w.goals } as WorkspaceRow;
    let last;
    // drive batches until this job is done or we run out of budget
    for (let i = 0; i < 20 && Date.now() < deadline; i++) {
      last = await runFlyerBatch(ws);
      if (last.status !== "running") break;
    }
    out.push({ workspace: w.name, processed: last?.processed ?? 0, total: last?.total ?? 0, deals: last?.deals ?? 0, status: last?.status ?? "?" });
  }
  return { swept: out.length, jobs: out };
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const enqueue = new URL(req.url).searchParams.get("enqueue");
  if (enqueue) return NextResponse.json(await enqueueAndDrive(enqueue));
  return NextResponse.json(await sweep());
}
export const GET = handle;
export const POST = handle;
