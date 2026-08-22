import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { getWorkspaceJobs } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Collection job status for a workspace (UI polls this). `ephemeral` lets the
 *  banner pick the moment visual (radar) vs the everyday one (node-track). */
export async function GET(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  const jobs = await getWorkspaceJobs(workspaceId);
  const { data } = await createServiceClient().from("workspace").select("goals, target_business_id").eq("id", workspaceId).maybeSingle();
  const ephemeral = !!(data?.goals as any)?.ephemeral;
  const targetId = data?.target_business_id ?? null;
  const withTarget = jobs.map((j: any) => ({ ...j, isTarget: j.business_id === targetId }));
  // the flyer/image read runs as its own batched stage AFTER collection — surface
  // its progress so the "scraping" isn't invisible while it drains.
  const fj = (data?.goals as any)?.flyerJob;
  const flyers = fj && fj.status === "running" ? { processed: Number(fj.cursor ?? 0), total: Number(fj.total ?? 0) } : null;
  return NextResponse.json({ jobs: withTarget, ephemeral, flyers });
}
