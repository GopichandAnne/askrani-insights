import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ensureOrgForUser } from "@/lib/auth";
import { persistAnalysis } from "@/lib/persist";
import type { PipelineOffer } from "@/lib/extraction/pipeline";

/**
 * TEMPORARY integration check — exercises the real persistence path against the
 * live database through the actual Next runtime, then cleans up everything it
 * created (test user + all rows). Gated by a token. Delete this route after use.
 */
export const dynamic = "force-dynamic";

function offer(entity: string, amount: number): PipelineOffer {
  return {
    entity_text: entity,
    canonical_entity_id: null,
    offer_type: "regular",
    pricing: { type: "regular", amount, currency: "USD" },
    conditions: [],
    validity_start: null,
    validity_end: null,
    confidence: 0.97,
    provenance: "PUBLIC_WEBSITE_HTTP",
    evidence: [{ kind: "dom_element", locator: { source: "selfcheck" }, text: entity }],
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("token") !== "local-selfcheck") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const svc = createServiceClient();
  const email = `selfcheck+${Date.now()}@example.com`;
  const log: string[] = [];
  let userId: string | undefined;
  let workspaceId: string | undefined;
  const businessIds: string[] = [];

  try {
    // 1) create a confirmed test user (bypasses email-confirm setting)
    const { data: created, error: cErr } = await svc.auth.admin.createUser({
      email,
      password: "selfcheck-pass-123",
      email_confirm: true,
    });
    if (cErr) throw new Error(`createUser: ${cErr.message}`);
    userId = created.user.id;
    log.push(`created test user ${email}`);

    // 2) org bootstrap
    const orgId = await ensureOrgForUser(userId, email);
    log.push(`ensured org ${orgId}`);

    // 3) persist a synthetic analysis (real persistAnalysis code path)
    const res = await persistAnalysis({
      orgId,
      target: {
        name: "Selfcheck Diner",
        url: `https://selfcheck-${Date.now()}.example`,
        offers: [offer("Butter Chicken", 16.99), offer("Chicken Biryani", 15.5)],
      },
      competitors: [
        {
          name: "Rival Kitchen",
          url: `https://rival-${Date.now()}.example`,
          offers: [offer("Weekday Lunch Special", 11.99), offer("Butter Chicken", 15.0)],
        },
      ],
      recommendations: [
        {
          category: "promotion",
          title: "Own the weekday lunch gap",
          action: "Test a weekday lunch special.",
          why_now: ["1 of 1 peers promote lunch; you don't."],
          evidence: ["Rival Kitchen: lunch offer"],
          expected_impact: { metric: "weekday_orders", range_pct: [5, 12], confidence: 0.55 },
          effort: "medium",
          urgency: "this_week",
          priority: 2.3,
        },
      ],
    });
    workspaceId = res.workspaceId;
    businessIds.push(res.targetBusinessId);
    log.push(`persisted: ${JSON.stringify(res)}`);

    // 4) read back to confirm rows exist
    const [{ count: offers }, { count: recs }, { count: edges }] = await Promise.all([
      svc.from("offer").select("*", { count: "exact", head: true }).eq("business_id", res.targetBusinessId),
      svc.from("recommendation").select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId),
      svc.from("competitor_edge").select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    ]);
    const { data: edgeRows } = await svc
      .from("competitor_edge")
      .select("competitor_id")
      .eq("workspace_id", workspaceId);
    for (const e of edgeRows ?? []) businessIds.push(e.competitor_id as string);

    const readback = { targetOffers: offers, recommendations: recs, competitorEdges: edges };
    log.push(`readback: ${JSON.stringify(readback)}`);

    const ok = (offers ?? 0) >= 2 && (recs ?? 0) >= 1 && (edges ?? 0) >= 1;

    // 5) cleanup — remove everything we created
    await svc.from("recommendation").delete().eq("workspace_id", workspaceId);
    await svc.from("competitor_edge").delete().eq("workspace_id", workspaceId);
    await svc.from("offer").delete().in("business_id", businessIds);
    await svc.from("content_item").delete().in("business_id", businessIds);
    await svc.from("workspace").delete().eq("id", workspaceId);
    await svc.from("external_identity").delete().in("business_id", businessIds);
    await svc.from("business").delete().in("id", businessIds);
    const { data: mem } = await svc.from("org_membership").select("organization_id").eq("user_id", userId);
    await svc.from("org_membership").delete().eq("user_id", userId);
    for (const m of mem ?? []) await svc.from("organization").delete().eq("id", m.organization_id);
    await svc.auth.admin.deleteUser(userId);
    log.push("cleaned up test data");

    return NextResponse.json({ ok, readback, log });
  } catch (e) {
    // best-effort cleanup of the auth user on failure
    if (userId) {
      try {
        await svc.auth.admin.deleteUser(userId);
      } catch {}
    }
    return NextResponse.json({ ok: false, error: (e as Error).message, log }, { status: 500 });
  }
}
