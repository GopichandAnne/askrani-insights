import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireOrg } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
import { buildScorecard } from "@/lib/scorecard";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Create (or refresh) a public, claimable snapshot of the active workspace's
 * scorecard — the "free market read" you hand out. Freezes the computed scorecard
 * onto goals.publicRead so /read/[token] can render it with no auth. Reuses the
 * existing token so the link stays stable.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const sc = await buildScorecard(state.workspace);
  if (sc.empty) return NextResponse.json({ error: "not enough data yet" }, { status: 400 });

  const svc = createServiceClient();
  const { data: w } = await svc.from("workspace").select("goals").eq("id", state.workspace.id).maybeSingle();
  const goals = (w?.goals ?? {}) as Record<string, any>;
  const token = (goals.publicRead?.token as string) || randomUUID().replace(/-/g, "").slice(0, 22);
  const publicRead = { token, scorecard: sc, businessName: state.workspace.name, at: new Date().toISOString() };
  await svc.from("workspace").update({ goals: { ...goals, publicRead } }).eq("id", state.workspace.id);

  const origin = new URL(req.url).origin;
  return NextResponse.json({ url: `${origin}/read/${token}`, path: `/read/${token}` });
}
