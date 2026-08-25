import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { buildScorecard } from "@/lib/scorecard";
import { intelCoverage } from "@/lib/ask";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Dev/diagnostic: which synthesized pillars Ask Rani currently has in context for
 * the active workspace. Owner-authed (not public). Spot-check after changes with
 * GET /api/dev/ask-coverage — returns a present/absent map + the count.
 */
export async function GET() {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no active workspace" }, { status: 400 });
  const ws = state.workspace;

  const svc = createServiceClient();
  const [scorecard, { data: wRow }] = await Promise.all([
    buildScorecard(ws, svc),
    svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle(),
  ]);
  const coverage = intelCoverage(scorecard, (wRow?.goals ?? {}) as Record<string, any>);
  const present = Object.values(coverage).filter(Boolean).length;

  return NextResponse.json({
    workspace: ws.name,
    vertical: ws.vertical,
    present,
    of: Object.keys(coverage).length,
    coverage, // { scorecard: true, briefing: true, ... flyerDeals: false }
  });
}
