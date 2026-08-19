import { NextResponse } from "next/server";
import { requireOrg, workspaceInOrg, unauthorized, badRequest } from "@/lib/api";
import { spendCredits, refundCredits, getBalance } from "@/lib/credits";
import { refreshFindability, computeFindabilityBrief, FINDABILITY_REFRESH_CREDITS } from "@/lib/findability";
import { createServiceClient } from "@/lib/supabase/server";
import { type WorkspaceRow } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * On-demand Findability refresh — owner-triggered, CREDIT-CHARGED. Charge first,
 * refund if the run couldn't activate (no Google key / no target / no geo), and
 * stamp goals.lastFindabilityAt so the weekly cron doesn't immediately re-run.
 * (Weekly refresh is plan-included and runs via /api/findability/tick.)
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { workspaceId } = await req.json().catch(() => ({}));
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(String(workspaceId), auth.orgId))) return unauthorized();

  const ok = await spendCredits(auth.orgId, FINDABILITY_REFRESH_CREDITS, "findability_refresh", { workspaceId });
  if (!ok) return NextResponse.json({ needsCredits: true, quote: FINDABILITY_REFRESH_CREDITS, balance: await getBalance(auth.orgId) });

  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("id, name, vertical, target_business_id, goals").eq("id", workspaceId).maybeSingle();
  if (!ws) {
    await refundCredits(auth.orgId, FINDABILITY_REFRESH_CREDITS, "findability_refund", { workspaceId });
    return badRequest("unknown workspace");
  }

  const result = await refreshFindability(ws as unknown as WorkspaceRow);
  if (!result.activated) {
    await refundCredits(auth.orgId, FINDABILITY_REFRESH_CREDITS, "findability_refund", { workspaceId });
    return NextResponse.json({ ok: false, ...result, note: "Nothing to measure yet — needs a located target business." });
  }

  const brief = await computeFindabilityBrief(ws as unknown as WorkspaceRow);
  await svc.from("workspace").update({
    goals: { ...((ws.goals ?? {}) as Record<string, unknown>), lastFindabilityAt: new Date().toISOString(), findabilityBrief: brief },
  }).eq("id", workspaceId);

  return NextResponse.json({ ok: true, ...result });
}
