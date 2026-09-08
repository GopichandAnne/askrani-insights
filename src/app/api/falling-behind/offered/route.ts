import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { conceptKey } from "@/lib/conceptcanon";

export const dynamic = "force-dynamic";

/**
 * Owner-confirm "we already offer this" — appends a concept to goals.weOffer so the
 * "falling behind" detector stops flagging it (the owner isn't behind on something
 * they do). The robust target-gap source when the owner's menu isn't collected.
 * Scoped to the caller's active workspace (RLS resolve); write via service client.
 */
export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no active workspace" }, { status: 401 });
  const wsId = state.workspace.id;

  let body: { concept?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const concept = String(body.concept ?? "").trim();
  const key = conceptKey(concept);
  if (!key) return NextResponse.json({ error: "concept required" }, { status: 400 });

  try {
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
    const goals = (cur?.goals as Record<string, unknown> | null) ?? {};
    const weOffer = Array.isArray(goals.weOffer) ? (goals.weOffer as string[]) : [];
    if (!weOffer.some((s) => conceptKey(String(s)) === key)) weOffer.push(concept);
    await svc.from("workspace").update({ goals: { ...goals, weOffer } }).eq("id", wsId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
