import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
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
  // The promote button lives on the ephemeral workspace's own pages, so default
  // to the active workspace; still accept an explicit id in the body.
  const body = await req.json().catch(() => ({}));
  let workspaceId: string | undefined = typeof body?.workspaceId === "string" ? body.workspaceId : undefined;
  if (!workspaceId) {
    const state = await activeWorkspace();
    if (state.status === "ok") workspaceId = state.workspace.id;
  }
  if (!workspaceId) return badRequest("No active workspace to promote.");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  // as='area' converts the snapshot into an AREA-subject monitored workspace (no
  // "you" — the anchor becomes a peer); default keeps it as a business you monitor.
  const asArea = body?.as === "area";

  const svc = createServiceClient();
  const { data: row } = await svc.from("workspace").select("goals, target_business_id, vertical").eq("id", workspaceId).maybeSingle();
  const goals = (row?.goals as Record<string, any>) ?? {};
  if (!goals.ephemeral) return NextResponse.json({ ok: true, alreadyMonitored: true });

  // credit back the scan cost if still within the retention window and not already refunded
  const within = goals.ephemeralExpiresAt ? Date.now() < Date.parse(goals.ephemeralExpiresAt) : false;
  const credited = within && !goals.deepReadRefunded ? Number(goals.deepReadCharged ?? 0) : 0;
  if (credited > 0) await refundCredits(auth.orgId, credited, "deep_read_promotion_credit", { workspaceId, as: asArea ? "area" : "business" });

  const next = { ...goals };
  next.ephemeral = false;
  delete next.ephemeralAt;
  delete next.ephemeralExpiresAt;
  delete next.deepReadScope;
  delete next.deepReadQuote;
  next.lastScheduledRefresh = null;        // let the scheduler pick it up next tick
  if (credited > 0) next.deepReadRefunded = true;

  const update: Record<string, unknown> = { goals: next };
  if (asArea) {
    const anchorId = (row as any)?.target_business_id as string | null;
    // keep the anchor in the watched set as a peer, then drop it as the target
    if (anchorId) {
      await svc.from("competitor_edge").upsert(
        { workspace_id: workspaceId, competitor_id: anchorId, relation: "primary", tier: "standard", score: 0.5, score_components: { area: true, wasAnchor: true }, rationale: "In the monitored area" },
        { onConflict: "workspace_id,competitor_id" },
      );
    }
    // derive the area subject (center + label) from the anchor business
    let center: { lat: number; lng: number } | null = null;
    let areaName = "nearby";
    if (anchorId) {
      const { data: biz } = await svc.from("business").select("attributes").eq("id", anchorId).maybeSingle();
      const a = ((biz?.attributes as Record<string, any>) ?? {});
      if (typeof a.lat === "number" && typeof a.lng === "number") center = { lat: a.lat, lng: a.lng };
      areaName = deriveAreaLabel(typeof a.address === "string" ? a.address : undefined) ?? areaName;
    }
    const vertical = (row as any)?.vertical as string | undefined;
    const keyword = verticalKeyword(vertical);
    next.subjectType = "area";
    next.subject = { area: areaName, keyword, center };
    update.target_business_id = null;
    const what = keyword ? keyword.replace(/\b\w/g, (c) => c.toUpperCase()) : "Businesses";
    update.name = `${what} · ${areaName}`;
  }
  await svc.from("workspace").update(update).eq("id", workspaceId);

  void logEvent("workspace_promoted", { workspaceId, credited, as: asArea ? "area" : "business" }, { orgId: auth.orgId });
  return NextResponse.json({ ok: true, credited, as: asArea ? "area" : "business" });
}

/** A short area label from a business address — a 5-digit ZIP if present, else the
 *  city (second-to-last comma part). Best-effort; falls back to null. */
function deriveAreaLabel(address?: string): string | null {
  if (!address) return null;
  const zip = address.match(/\b(\d{5})\b/);
  if (zip) return zip[1];
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? null);
}

/** Plain keyword for an area subject from the workspace vertical. */
function verticalKeyword(vertical?: string): string {
  const MAP: Record<string, string> = { salon: "med spa", restaurant: "restaurant", grocery: "grocery" };
  return MAP[vertical ?? ""] ?? "businesses";
}
