import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshFindability, computeFindabilityBrief } from "@/lib/findability";
import { planOfOrg, cadenceForPlan } from "@/lib/credits";
import { type WorkspaceRow } from "@/lib/workspace";

type TickRow = WorkspaceRow & { organization_id: string };

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Weekly Findability refresh — PLAN-INCLUDED (records Places COGS, does not charge
 * credits). Fires daily on Vercel cron and self-gates per workspace to the plan's
 * cadence (weekly by default) via goals.lastFindabilityAt. Bounded per tick; at
 * scale this moves to the enqueue pattern. Worker/cron authed.
 */
const PER_TICK_CAP = 10;
const DAY = 86_400_000;

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

async function run(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data: wss } = await svc.from("workspace").select("id, name, vertical, organization_id, target_business_id, goals").limit(1000);
  const now = Date.now();
  let processed = 0, skipped = 0;

  for (const ws of (wss ?? []) as TickRow[]) {
    if (processed >= PER_TICK_CAP) break;
    const goals = (ws.goals ?? {}) as Record<string, unknown>;
    if (!ws.target_business_id || goals.ephemeral) { skipped++; continue; }

    const cadence = cadenceForPlan(await planOfOrg(ws.organization_id)); // daily | weekly
    const intervalMs = (cadence === "daily" ? 1 : 7) * DAY;
    const last = goals.lastFindabilityAt ? Date.parse(String(goals.lastFindabilityAt)) : 0;
    if (now - last < intervalMs - 3_600_000) { skipped++; continue; } // 1h slack

    try {
      const r = await refreshFindability(ws);
      if (r.activated) {
        // Cache the compact brief on goals for the weekly digest (buildDigest reads
        // goals.findabilityBrief — no scrape/LLM at digest time).
        const brief = await computeFindabilityBrief(ws);
        await svc.from("workspace").update({ goals: { ...goals, lastFindabilityAt: new Date().toISOString(), findabilityBrief: brief } }).eq("id", ws.id);
        processed++;
      } else skipped++;
    } catch (e) {
      console.error(`[findability/tick] ${ws.id}: ${e instanceof Error ? e.message : e}`);
      skipped++;
    }
  }
  return NextResponse.json({ ok: true, processed, skipped });
}

export const GET = run;
export const POST = run;
