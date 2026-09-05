import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { answerFromData } from "@/lib/assistant";
import { applyAssistantAction } from "@/lib/assistantActions";
import { readConversation, appendConversation, recentTurns } from "@/lib/conversation";

/**
 * POST /api/assistant/chat — the in-app chat, powered by the same advisor brain as
 * WhatsApp (answerFromData): grounded in the workspace's collected data + live rows
 * + upcoming occasions. Conversation memory is now PERSISTENT + shared with WhatsApp
 * (goals.conversation), so context carries across sessions, reloads and channels.
 * GET returns the stored thread so the chat shows prior conversation on open.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ turns: [] });
  const turns = await readConversation(createServiceClient(), state.workspace.id);
  return NextResponse.json({ turns: turns.map((t) => ({ role: t.role, text: t.text })) });
}

export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const body = (await req.json().catch(() => ({}))) as { message?: string };
  const message = typeof body.message === "string" ? body.message.slice(0, 1000) : "";
  if (!message.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  const supabase = await createClient();
  const svcAdmin = createServiceClient();

  // The persistent per-workspace thread (shared with WhatsApp) is the source of
  // truth for context — the conversation carries across sessions, reloads, channels.
  const history = recentTurns(await readConversation(svcAdmin, ws.id), 10);

  const { answer, grounded, sources, action } = await answerFromData(
    { id: ws.id, name: ws.name, vertical: ws.vertical, target_business_id: ws.target_business_id },
    ((ws as { goals?: Record<string, unknown> }).goals as Record<string, any>) ?? {},
    message, history, supabase,
  );

  // If the copilot decided on a config change, execute it against THIS workspace.
  let finalAnswer = answer;
  let changed = false;
  if (action) {
    const res = await applyAssistantAction(svcAdmin, { id: ws.id }, action);
    changed = res.ok;
    if (!res.ok) finalAnswer = res.note ? `I couldn't do that — ${res.note}` : "I couldn't make that change — please try again.";
  }

  // Remember this exchange for next time (this session, a reload, or WhatsApp).
  await appendConversation(svcAdmin, ws.id, [{ role: "user", text: message }, { role: "assistant", text: finalAnswer }]);

  return NextResponse.json({ answer: finalAnswer, grounded, sources: sources ?? [], changed });
}
