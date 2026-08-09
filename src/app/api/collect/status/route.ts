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
  const { data } = await createServiceClient().from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
  const ephemeral = !!(data?.goals as any)?.ephemeral;
  return NextResponse.json({ jobs, ephemeral });
}
