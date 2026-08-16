import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { answerFromData, type WaTurn } from "@/lib/assistant";
import { applyAssistantAction } from "@/lib/assistantActions";

/**
 * POST /api/assistant/chat — the in-app chat, powered by the same advisor brain as
 * WhatsApp (answerFromData): grounded in the workspace's collected data + live rows
 * + upcoming occasions, conversational via the client-sent history. Uses the RLS
 * client so it reads only what this user's workspace is allowed to.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const body = (await req.json().catch(() => ({}))) as { message?: string; history?: WaTurn[] };
  const message = typeof body.message === "string" ? body.message.slice(0, 1000) : "";
  if (!message.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  const history: WaTurn[] = Array.isArray(body.history)
    ? body.history.filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string").slice(-8)
    : [];

  const supabase = await createClient();
  const { answer, grounded, sources, action } = await answerFromData(
    { id: ws.id, name: ws.name, vertical: ws.vertical, target_business_id: ws.target_business_id },
    ((ws as { goals?: Record<string, unknown> }).goals as Record<string, any>) ?? {},
    message, history, supabase,
  );

  // If the copilot decided on a config change, execute it against THIS workspace
  // (activeWorkspace already scoped ws to the signed-in user). On failure, the
  // model's confirming answer would be wrong — replace it with the reason.
  let finalAnswer = answer;
  let changed = false;
  if (action) {
    const res = await applyAssistantAction(createServiceClient(), { id: ws.id }, action);
    changed = res.ok;
    if (!res.ok) finalAnswer = res.note ? `I couldn't do that — ${res.note}` : "I couldn't make that change — please try again.";
  }

  return NextResponse.json({ answer: finalAnswer, grounded, sources: sources ?? [], changed });
}
