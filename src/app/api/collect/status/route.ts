import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { getWorkspaceJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** Collection job status for a workspace (UI polls this). */
export async function GET(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  const jobs = await getWorkspaceJobs(workspaceId);
  return NextResponse.json({ jobs });
}
