import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { generateAction } from "@/lib/act";
import type { ActKind } from "@/lib/digest";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const KINDS = new Set<ActKind>(["reply", "promo", "content"]);

/** Close the loop: turn an insight into a ready-to-send artifact, and log it. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const kind = body?.kind as ActKind;
  const move = typeof body?.move === "string" ? body.move.trim() : "";
  const context = typeof body?.context === "string" ? body.context : undefined;
  if (!KINDS.has(kind)) return NextResponse.json({ error: "kind must be reply|promo|content" }, { status: 400 });
  if (!move) return NextResponse.json({ error: "move required" }, { status: 400 });

  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const ws = state.workspace;

  const artifact = await generateAction({ business: ws.name, vertical: ws.vertical, kind, move, context });
  if ("error" in artifact) return NextResponse.json({ error: artifact.error }, { status: 500 });

  // log the action so we can later attribute outcomes (ROI proof); best-effort.
  try {
    const svc = createServiceClient();
    const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    const goals = (data?.goals as Record<string, any>) ?? {};
    const log = Array.isArray(goals.actions) ? goals.actions : [];
    log.unshift({ at: new Date().toISOString(), kind, move: move.slice(0, 200) });
    await svc.from("workspace").update({ goals: { ...goals, actions: log.slice(0, 100) } }).eq("id", ws.id);
  } catch { /* logging is best-effort */ }

  return NextResponse.json(artifact);
}
