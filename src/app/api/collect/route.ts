import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { collectBusiness } from "@/lib/collect";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // a single business crawl+extract can take a while

/** Collect one business. Verifies the business is the target or a competitor of a
 *  workspace in the caller's org before doing any work. */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { businessId } = await req.json().catch(() => ({}));
  if (!businessId) return badRequest("businessId required");

  const svc = createServiceClient();
  // authorize: business must belong to one of the caller's workspaces
  const { data: asTarget } = await svc
    .from("workspace")
    .select("id")
    .eq("organization_id", auth.orgId)
    .eq("target_business_id", businessId)
    .limit(1)
    .maybeSingle();
  let ok = !!asTarget;
  if (!ok) {
    const { data: edge } = await svc
      .from("competitor_edge")
      .select("id,workspace:workspace_id(organization_id)")
      .eq("competitor_id", businessId)
      .limit(50);
    ok = (edge ?? []).some((e: any) => (e.workspace as any)?.organization_id === auth.orgId);
  }
  if (!ok) return unauthorized();

  const result = await collectBusiness(businessId);
  return NextResponse.json(result);
}
