import { createServiceClient } from "@/lib/supabase/server";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";
import { hasCredits, PLANS } from "@/lib/credits";

/**
 * Cadence scheduler — makes monitoring "always-on". A cron calls runScheduler()
 * periodically; for each workspace that's due (per its plan cadence) and whose
 * org has credits, it enqueues a fresh collection. The existing worker drains
 * the queue. Last-run time is stamped on workspace.goals.lastScheduledRefresh so
 * we don't re-enqueue until the next cadence window. Credit-paused orgs are
 * skipped (not stamped) so they resume automatically once funded.
 */

const DAY = 86_400_000;
const SLACK_MS = 60 * 60 * 1000; // 1h, so an hourly cron reliably catches "due"

export interface SchedulerResult {
  checked: number;
  due: number;
  enqueued: number;
  pausedNoCredits: number;
  ephemeralCleaned: number;
}

export async function runScheduler(): Promise<SchedulerResult> {
  const svc = createServiceClient();
  const { data: wss } = await svc.from("workspace").select("id, organization_id, goals, target_business_id");
  const workspaces = wss ?? [];

  // Deep-read (ephemeral) workspaces are one-shot snapshots — never recur, and are
  // cleaned up once past their retention window (30 days). Promotion clears the flag.
  const nowMs = Date.now();
  let ephemeralCleaned = 0;
  for (const w of workspaces as any[]) {
    const exp = w.goals?.ephemeralExpiresAt ? Date.parse(w.goals.ephemeralExpiresAt) : 0;
    if (w.goals?.ephemeral && exp && nowMs > exp) {
      await svc.from("workspace").delete().eq("id", w.id).then(() => { ephemeralCleaned++; }, () => {});
    }
  }

  const orgIds = [...new Set(workspaces.map((w: any) => w.organization_id).filter(Boolean))] as string[];
  const { data: orgs } = await svc.from("organization").select("id, settings").in("id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]);
  const planOf = new Map((orgs ?? []).map((o: any) => [o.id, (o.settings?.billing?.plan as string) ?? "free"]));

  const now = Date.now();
  let due = 0, enqueued = 0, pausedNoCredits = 0;
  const creditCache = new Map<string, boolean>();

  for (const w of workspaces as any[]) {
    // Area workspaces (goals.subjectType==='area') have no target but still watch
    // a set of businesses — schedule them too. Only skip if nothing is set up.
    if (!w.target_business_id && w.goals?.subjectType !== "area") continue;
    if (w.goals?.ephemeral) continue;    // deep reads never recur (one-shot snapshot)
    const cadence = PLANS[String(planOf.get(w.organization_id) ?? "")]?.cadence ?? "weekly";
    const intervalMs = (cadence === "daily" ? 1 : 7) * DAY;
    const last = w.goals?.lastScheduledRefresh ? Date.parse(w.goals.lastScheduledRefresh) : 0;
    if (last && now - last < intervalMs - SLACK_MS) continue; // not due yet
    due++;

    const orgId = w.organization_id as string | undefined;
    if (orgId) {
      let ok = creditCache.get(orgId);
      if (ok === undefined) { ok = await hasCredits(orgId); creditCache.set(orgId, ok); }
      if (!ok) { pausedNoCredits++; continue; } // don't stamp → retries when funded
    }

    enqueued += await enqueueWorkspaceCollection(w.id);
    // stamp so we don't re-enqueue until the next cadence window
    await svc.from("workspace").update({ goals: { ...(w.goals ?? {}), lastScheduledRefresh: new Date(now).toISOString() } }).eq("id", w.id);
  }

  if (enqueued > 0) await nudgeWorker();
  return { checked: workspaces.length, due, enqueued, pausedNoCredits, ephemeralCleaned };
}
