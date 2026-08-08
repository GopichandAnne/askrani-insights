import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { refundCredits } from "@/lib/credits";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * Promote a deep-read (ephemeral) workspace to a live Monitored one. Clears the
 * ephemeral flag so the scheduler starts refreshing it on cadence, and — within
 * the retention window — credits the deep-read charge back toward Monitor (removes
 * the "I already paid to look" friction at the moment of conversion). The already
 * collected data stays, so there's no re-scrape and no double charge.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { workspaceId } = await req.json().catch(() => ({}));
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  const svc = createServiceClient();
  const { data: row } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
  const goals = (row?.goals as Record<string, any>) ?? {};
  if (!goals.ephemeral) return NextResponse.json({ ok: true, alreadyMonitored: true });

  // credit back the scan cost if still within the retention window and not already refunded
  const within = goals.ephemeralExpiresAt ? Date.now() < Date.parse(goals.ephemeralExpiresAt) : false;
  const credited = within && !goals.deepReadRefunded ? Number(goals.deepReadCharged ?? 0) : 0;
  if (credited > 0) await refundCredits(auth.orgId, credited, "deep_read_promotion_credit", { workspaceId });

  const next = { ...goals };
  next.ephemeral = false;
  delete next.ephemeralAt;
  delete next.ephemeralExpiresAt;
  delete next.deepReadScope;
  delete next.deepReadQuote;
  next.lastScheduledRefresh = null;        // let the scheduler pick it up next tick
  if (credited > 0) next.deepReadRefunded = true;
  await svc.from("workspace").update({ goals: next }).eq("id", workspaceId);

  void logEvent("workspace_promoted", { workspaceId, credited }, { orgId: auth.orgId });
  return NextResponse.json({ ok: true, credited });
}
