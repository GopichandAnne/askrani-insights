import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { getUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { recordCompetitorLabel, type RejectReason } from "@/lib/competitorlabels";

export const dynamic = "force-dynamic";

/**
 * "Did Rani get your market right?" — the confirmation step that both improves the
 * owner's set AND banks labeled training data (competitor_label). Three actions:
 *   • confirm_all — mark every current primary competitor 'confirmed'
 *   • reject      — remove one competitor (deactivate its edge) + record why
 *   • add         — record that a named business SHOULD be a competitor (gold signal)
 * Scoped to the signed-in user's active workspace (RLS-verified via activeWorkspace).
 */
const REASONS = new Set<RejectReason>(["different_customers", "too_far", "different_price", "different_concept", "other"]);

export async function POST(req: Request) {
  const state = await activeWorkspace();
  const user = await getUser();
  if (state.status !== "ok" || !user) return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const body = (await req.json().catch(() => ({}))) as { action?: string; competitorId?: string; name?: string; reason?: string };
  const svc = createServiceClient();
  const { data: wsRow } = await svc.from("workspace").select("organization_id").eq("id", ws.id).maybeSingle();
  const organizationId = (wsRow?.organization_id as string) ?? null;
  const common = { workspaceId: ws.id, organizationId, subjectBusinessId: ws.target_business_id ?? null, vertical: ws.vertical, createdBy: user.id };

  if (body.action === "confirm_all") {
    // label every active primary competitor as confirmed
    const { data: edges } = await svc.from("competitor_edge")
      .select("competitor_id").eq("workspace_id", ws.id).eq("relation", "primary").is("active_to", null);
    const ids = ((edges ?? []) as { competitor_id: string }[]).map((e) => e.competitor_id);
    if (ids.length) {
      const { data: biz } = await svc.from("business").select("id, canonical_name").in("id", ids);
      const nameById = new Map(((biz ?? []) as any[]).map((b) => [b.id, b.canonical_name]));
      for (const id of ids) {
        await recordCompetitorLabel(svc, { ...common, competitorBusinessId: id, competitorName: nameById.get(id) ?? null, label: "confirmed" });
      }
    }
    return NextResponse.json({ ok: true, confirmed: ids.length });
  }

  if (body.action === "reject") {
    const competitorId = typeof body.competitorId === "string" ? body.competitorId : "";
    if (!competitorId) return NextResponse.json({ error: "competitorId required" }, { status: 400 });
    const reason = REASONS.has(body.reason as RejectReason) ? (body.reason as RejectReason) : "other";
    const { data: biz } = await svc.from("business").select("canonical_name").eq("id", competitorId).maybeSingle();
    await recordCompetitorLabel(svc, { ...common, competitorBusinessId: competitorId, competitorName: (biz?.canonical_name as string) ?? null, label: "rejected", reason });
    // deactivate the edge so it stops being monitored (keeps history via active_to)
    await svc.from("competitor_edge").update({ active_to: new Date().toISOString() }).eq("workspace_id", ws.id).eq("competitor_id", competitorId).is("active_to", null);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "add") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    await recordCompetitorLabel(svc, { ...common, competitorName: name, label: "added" });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
