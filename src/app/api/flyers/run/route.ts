import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { enqueueFlyerJob, flyersConfigured } from "@/lib/flyers";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { quoteFlyerRead, spendCredits, FLYER_READ_COMPETITOR_CAP } from "@/lib/credits";

/**
 * Start an async flyer read for the signed-in org's workspace. Charges credits up
 * front, resolves the competitor IG+FB profile list, and stores the job on
 * goals.flyerJob. The client then drives /api/flyers/tick until the job is done.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "sign in" }, { status: 401 });
  if (!flyersConfigured()) return NextResponse.json({ activated: false, reason: "Flyer reading isn't switched on yet (needs Apify + an AI key)." });

  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body.workspaceId ?? "").trim();
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("*").eq("id", workspaceId).maybeSingle();
  if (!ws || ws.organization_id !== auth.orgId) return NextResponse.json({ error: "workspace not found" }, { status: 404 });

  const ids = await workspaceBusinessIds(ws as WorkspaceRow, svc as any);
  const count = Math.min(ids.competitorIds.length, FLYER_READ_COMPETITOR_CAP);
  if (!count) return NextResponse.json({ activated: true, status: "idle", reason: "Add competitors with Instagram or Facebook pages first." });

  const quote = quoteFlyerRead(count);
  const charged = await spendCredits(auth.orgId, quote, "flyer_read", { workspaceId, competitors: count });
  if (!charged) return NextResponse.json({ error: "Not enough credits.", needed: quote }, { status: 402 });

  const { total } = await enqueueFlyerJob(ws as WorkspaceRow, auth.orgId, quote);
  if (!total) return NextResponse.json({ activated: true, status: "idle", reason: "No Instagram/Facebook pages connected for your competitors yet." });
  return NextResponse.json({ status: "running", total, charged: quote });
}
