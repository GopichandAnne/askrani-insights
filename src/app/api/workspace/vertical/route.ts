import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { isVertical } from "@/lib/classify";

export const dynamic = "force-dynamic";

/**
 * Owner self-serve: change the active workspace's business TYPE (vertical) in place.
 * Detection sets it at onboarding, but it can be wrong — this lets the owner correct
 * it without re-onboarding. Updates workspace.vertical (drives vocab, keyword
 * generation, festival fit, etc.) and the target business.vertical. It does NOT
 * re-discover competitors (that's the destructive re-onboard path); the corrected
 * type takes effect on the next refresh of the vertical-influenced surfaces.
 * Scoped to the signed-in user's active workspace (RLS-verified via activeWorkspace).
 */
export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const body = (await req.json().catch(() => ({}))) as { vertical?: string };
  const vertical = String(body.vertical ?? "");
  if (!isVertical(vertical)) return NextResponse.json({ error: "invalid_vertical" }, { status: 400 });
  if (vertical === ws.vertical) return NextResponse.json({ ok: true, vertical });

  const svc = createServiceClient();
  const { error } = await svc.from("workspace").update({ vertical }).eq("id", ws.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (ws.target_business_id) {
    await svc.from("business").update({ vertical }).eq("id", ws.target_business_id).then(() => {}, () => {});
  }
  return NextResponse.json({ ok: true, vertical });
}
