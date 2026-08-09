import { createServiceClient } from "@/lib/supabase/server";
import { collectBusiness, refreshRecommendations } from "@/lib/collect";
import { detectEventsForBusiness } from "@/lib/events";
import { spendForCost, hasCredits } from "@/lib/credits";
import { warmWorkspaceSynthesis } from "@/lib/warm";

/** Error sentinel marking a job paused for lack of credits (re-queueable). */
export const PAUSE_SENTINEL = "MONITORING_PAUSED_NO_CREDITS";

/** Re-activate credit-paused jobs for an org (call after credits are added). */
export async function requeuePausedForOrg(orgId: string): Promise<number> {
  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("id").eq("organization_id", orgId);
  const ids = (ws ?? []).map((w: any) => w.id);
  if (!ids.length) return 0;
  const { data } = await svc.from("collection_job").update({ status: "pending", error: null }).in("workspace_id", ids).eq("error", PAUSE_SENTINEL).select("id");
  return data?.length ?? 0;
}

/**
 * Background collection queue (guide §5.3). Enqueue jobs; a worker drains them
 * via processOneJob(). Keeps heavy crawl+extract off the request/browser path.
 */

const MAX_ATTEMPTS = 3;
type Svc = ReturnType<typeof createServiceClient>;

/** Enqueue a collect job per business in the workspace (target first). Idempotent
 *  — skips a business that already has a pending/running job. */
export async function enqueueWorkspaceCollection(workspaceId: string): Promise<number> {
  const svc = createServiceClient();
  const { data: ws } = await svc
    .from("workspace")
    .select("target_business_id")
    .eq("id", workspaceId)
    .maybeSingle();
  const { data: edges } = await svc
    .from("competitor_edge")
    .select("competitor_id")
    .eq("workspace_id", workspaceId);

  const businesses: { id: string; priority: number }[] = [];
  if (ws?.target_business_id) businesses.push({ id: ws.target_business_id as string, priority: 10 });
  for (const e of edges ?? []) businesses.push({ id: e.competitor_id as string, priority: 0 });

  let enqueued = 0;
  for (const b of businesses) {
    enqueued += await enqueueOne(svc, workspaceId, b.id, b.priority);
  }
  return enqueued;
}

/** Enqueue a single business (used on manual competitor-add too). */
export async function enqueueOne(
  svc: Svc,
  workspaceId: string,
  businessId: string,
  priority = 0,
): Promise<number> {
  const { data: existing } = await svc
    .from("collection_job")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("business_id", businessId)
    .in("status", ["pending", "running"])
    .limit(1)
    .maybeSingle();
  if (existing) return 0;

  const { error } = await svc
    .from("collection_job")
    .insert({ workspace_id: workspaceId, business_id: businessId, priority, status: "pending" });
  // a concurrent insert can trip the partial unique index — treat as already-queued
  return error ? 0 : 1;
}

export interface TickResult {
  processed: boolean;
  jobId?: string;
  businessId?: string;
  status?: "done" | "error" | "blocked";
  offersWritten?: number;
  remaining: number;
}

/** Requeue jobs left 'running' by an interrupted function (self-healing). */
export async function requeueStaleJobs(staleMinutes = 8): Promise<void> {
  const svc = createServiceClient();
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  await svc
    .from("collection_job")
    .update({ status: "pending", error: "requeued after stall" })
    .eq("status", "running")
    .lt("claimed_at", cutoff);
}

/**
 * Fire-and-forget nudge so collection starts immediately after enqueue instead
 * of waiting for the next cron tick. Best-effort: we kick the batch-drain
 * endpoint and don't block on it (the tick keeps running server-side).
 */
export async function nudgeWorker(): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) return;
  try {
    await fetch(`${base}/api/worker/tick`, {
      method: "GET",
      headers: { "x-worker-secret": secret },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // aborting our wait is expected — the tick function continues on its own
  }
}

/** Kick synthesis warm-up in its OWN function invocation (separate 300s budget).
 *  Falls back to running inline when there's no worker URL/secret (local worker). */
async function nudgeWarm(workspaceId: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) {
    await warmWorkspaceSynthesis(workspaceId);
    return;
  }
  try {
    await fetch(`${base}/api/warm`, {
      method: "POST",
      headers: { "x-worker-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // aborting our wait is expected — the warm function continues on its own
  }
}

/** Kick the deep-read finalize (competitor ads + flyer scans) in its OWN function
 *  invocation once a deep read's collection is done. Falls back to inline when
 *  there's no worker URL/secret (local worker). */
async function nudgeDeepReadFinalize(workspaceId: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) {
    // inline fallback (local dev): run the scans directly
    try {
      const svc = createServiceClient();
      const { data } = await svc.from("workspace").select("id,name,vertical,target_business_id").eq("id", workspaceId).maybeSingle();
      if (data) {
        const { refreshCompetitorAds } = await import("@/lib/ads");
        const { refreshFlyers } = await import("@/lib/flyers");
        await refreshCompetitorAds(data as any).catch(() => {});
        await refreshFlyers(data as any).catch(() => {});
      }
    } catch { /* best-effort */ }
    return;
  }
  try {
    await fetch(`${base}/api/deep-read/finalize`, {
      method: "POST",
      headers: { "x-worker-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // aborting our wait is expected — the finalize function continues on its own
  }
}

/** Claim and process one job. Returns processed:false when the queue is empty. */
export async function processOneJob(): Promise<TickResult> {
  const svc = createServiceClient();

  await requeueStaleJobs();
  const { data: job, error } = await svc.rpc("claim_collection_job");
  if (error) throw new Error(`claim: ${error.message}`);
  if (!job || !job.id) return { processed: false, remaining: await pendingCount(svc) };

  // Resolve the owning org once (used for the credit gate + debit + deep-read finalize).
  const { data: wsRow } = await svc.from("workspace").select("organization_id, goals").eq("id", job.workspace_id).maybeSingle();
  const orgId = (wsRow?.organization_id as string | undefined) ?? undefined;
  const isDeepRead = !!(wsRow?.goals as any)?.ephemeral;

  // ── Phase 2 gate: don't run collection when the org is out of credits ──
  if (orgId && !(await hasCredits(orgId))) {
    await svc.from("collection_job").update({ status: "error", error: PAUSE_SENTINEL }).eq("id", job.id);
    return { processed: true, jobId: job.id, businessId: job.business_id, status: "blocked", offersWritten: 0, remaining: await pendingCount(svc) };
  }

  let outcome: "done" | "error" = "done";
  let offersWritten = 0;
  const runStart = new Date().toISOString();
  try {
    const res = await collectBusiness(job.business_id);
    offersWritten = res.offersWritten;
    // detect changes vs history (no-op on first collection) — guide §5
    try {
      await detectEventsForBusiness(job.business_id, job.workspace_id);
    } catch {
      /* detection is best-effort; never fail the job on it */
    }
    await svc
      .from("collection_job")
      .update({ status: "done", result: res, error: res.error ?? null })
      .eq("id", job.id);
  } catch (e) {
    const msg = (e as Error).message;
    // retry a few times before giving up
    if (job.attempts < MAX_ATTEMPTS) {
      await svc.from("collection_job").update({ status: "pending", error: msg }).eq("id", job.id);
    } else {
      await svc.from("collection_job").update({ status: "error", error: msg }).eq("id", job.id);
    }
    outcome = "error";
  }

  // Phase 1 credits (record-only, no gating): debit the org for what this
  // collection actually cost, summed from the provider_run rows it wrote.
  if (outcome === "done" && orgId) {
    try {
      const { data: runs } = await svc
        .from("provider_run")
        .select("cost_usd")
        .like("input_hash", `${job.business_id}:%`)
        .gte("finished_at", runStart);
      const costUsd = (runs ?? []).reduce((a: number, r: any) => a + (Number(r.cost_usd) || 0), 0);
      if (costUsd > 0) await spendForCost(orgId, costUsd, { business_id: job.business_id, workspace_id: job.workspace_id });
    } catch { /* record-only — never fail the job on credits */ }
  }

  // When the workspace's queue is drained, refresh its recommendations.
  const { count } = await svc
    .from("collection_job")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", job.workspace_id)
    .in("status", ["pending", "running"]);
  if ((count ?? 0) === 0) {
    try {
      await refreshRecommendations(job.workspace_id);
    } catch {
      /* non-fatal */
    }
    // Warm the synthesis caches (briefing/edge/trends/news) now that collection
    // is done, so the owner's first page load is instant — not a ~40s edge wait.
    // Kicked as a SEPARATE function invocation (via /api/warm) so it gets its own
    // 300s budget instead of sharing this collection function's — a heavy
    // workspace's collection would otherwise starve the warm.
    try {
      await nudgeWarm(job.workspace_id);
    } catch {
      /* non-fatal — readers regenerate on demand if this didn't run */
    }
    // A deep read is the COMPLETE picture — run competitor ads + flyer scans now
    // that collection is done (part of the paid scan, not a subscription extra).
    if (isDeepRead) {
      try {
        await nudgeDeepReadFinalize(job.workspace_id);
      } catch {
        /* non-fatal — ads/flyers just stay empty if this didn't run */
      }
    }
  }

  return {
    processed: true,
    jobId: job.id,
    businessId: job.business_id,
    status: outcome,
    offersWritten,
    remaining: await pendingCount(svc),
  };
}

async function pendingCount(svc: Svc): Promise<number> {
  const { count } = await svc
    .from("collection_job")
    .select("*", { count: "exact", head: true })
    .in("status", ["pending", "running"]);
  return count ?? 0;
}

/** Jobs for a workspace (for the UI status poll). */
export async function getWorkspaceJobs(workspaceId: string) {
  const svc = createServiceClient();
  const { data } = await svc
    .from("collection_job")
    .select("business_id,status,result,error,updated_at, business:business_id(canonical_name, attributes)")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false });
  // Job rows accumulate per collection; keep only the LATEST job per business so
  // callers see one node per business (the current scan), not all-time history.
  // Include geo (attributes.geo) so the radar can place blips at true bearing.
  const seen = new Set<string>();
  const out: any[] = [];
  for (const j of (data ?? []) as any[]) {
    if (seen.has(j.business_id)) continue;
    seen.add(j.business_id);
    const geo = j.business?.attributes?.geo;
    out.push({ business_id: j.business_id, status: j.status, result: j.result, error: j.error, updated_at: j.updated_at, name: j.business?.canonical_name ?? "A business", lat: geo?.lat ?? null, lng: geo?.lng ?? null });
  }
  return out;
}
