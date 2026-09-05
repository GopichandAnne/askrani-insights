import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { setAttentionObjective, setAttentionMode, recordAttentionFeedback } from "@/lib/attention";
import type { AttnMode } from "@/lib/attention-prefs";

export const dynamic = "force-dynamic";

/**
 * Attention preferences (Phase 5 learning). The owner tunes what surfaces:
 *   { action: "objective", objective: "<slug>|null" }   — bias ranking to a goal
 *   { action: "mode", mode: "quiet|balanced|active" }    — how much surfaces
 *   { action: "feedback", kind: "<attn kind>", signal: "useful|not_useful|dismiss|acted" }
 * Scoped to the caller's active workspace (resolved via the RLS client, so it's
 * always a workspace they can see); the writes then use the service client.
 */
export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no active workspace" }, { status: 401 });
  const wsId = state.workspace.id;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action;

  try {
    if (action === "objective") {
      await setAttentionObjective(wsId, typeof body.objective === "string" ? body.objective : null);
    } else if (action === "mode") {
      await setAttentionMode(wsId, body.mode as AttnMode);
    } else if (action === "feedback") {
      if (typeof body.kind !== "string" || typeof body.signal !== "string") {
        return NextResponse.json({ error: "kind and signal required" }, { status: 400 });
      }
      await recordAttentionFeedback(wsId, body.kind, body.signal as "useful" | "not_useful" | "dismiss" | "acted");
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
