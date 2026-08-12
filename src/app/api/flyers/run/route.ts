import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshFlyers, flyersConfigured } from "@/lib/flyers";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { quoteFlyerRead, spendCredits, refundCredits, FLYER_READ_COMPETITOR_CAP } from "@/lib/credits";

/**
 * Owner-triggered flyer read for the signed-in org's workspace. Charges credits
 * up front (quoteFlyerRead), scrapes rivals' Instagram fresh, downloads the sale
 * flyers, and vision-extracts the printed prices. Refunds the charge if no flyer
 * images are found or the run errors, so the owner only pays when it delivers.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  if (!count) return NextResponse.json({ activated: true, flyers: 0, deals: 0, reason: "Add competitors with Instagram pages first." });

  const quote = quoteFlyerRead(count);
  const charged = await spendCredits(auth.orgId, quote, "flyer_read", { workspaceId, competitors: count });
  if (!charged) return NextResponse.json({ error: "Not enough credits.", needed: quote }, { status: 402 });

  try {
    const result = await refreshFlyers(ws as WorkspaceRow, { maxCompetitors: FLYER_READ_COMPETITOR_CAP, postsPerCompetitor: 4 });
    if (!result.flyers) {
      await refundCredits(auth.orgId, quote, "flyer_read_refund", { workspaceId });
      return NextResponse.json({ ...result, refunded: true, reason: "No flyer images found on rivals' Instagram right now." });
    }
    return NextResponse.json({ ...result, charged: quote });
  } catch (e) {
    await refundCredits(auth.orgId, quote, "flyer_read_refund", { workspaceId });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
