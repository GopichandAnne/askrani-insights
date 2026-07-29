import { createServiceClient } from "@/lib/supabase/server";
import { collectBusiness, refreshRecommendations } from "@/lib/collect";

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
  status?: "done" | "error";
  offersWritten?: number;
  remaining: number;
}

/** Claim and process one job. Returns processed:false when the queue is empty. */
export async function processOneJob(): Promise<TickResult> {
  const svc = createServiceClient();

  const { data: job, error } = await svc.rpc("claim_collection_job");
  if (error) throw new Error(`claim: ${error.message}`);
  if (!job || !job.id) return { processed: false, remaining: await pendingCount(svc) };

  let outcome: "done" | "error" = "done";
  let offersWritten = 0;
  try {
    const res = await collectBusiness(job.business_id);
    offersWritten = res.offersWritten;
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
    .select("business_id,status,result,error,updated_at")
    .eq("workspace_id", workspaceId);
  return data ?? [];
}
