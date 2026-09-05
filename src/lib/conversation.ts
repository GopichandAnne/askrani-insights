import { createServiceClient } from "@/lib/supabase/server";
import type { WaTurn } from "@/lib/assistant";

/**
 * Persistent conversation memory — a durable per-WORKSPACE thread, shared across
 * web + WhatsApp, so Rani remembers past chats across sessions and channels (ask
 * on WhatsApp today, pick it up on the web tomorrow). Stored on goals.conversation
 * (JSONB, no migration — same pattern as the other goals) and capped so it can't
 * grow unbounded. The workspace's collected DATA is the deep memory; this is the
 * transcript on top of it.
 */
export type ConvoTurn = WaTurn & { at?: string };
const MAX_TURNS = 40; // ~20 exchanges kept per business

type Svc = ReturnType<typeof createServiceClient>;

/** The stored thread for a workspace (oldest → newest). */
export async function readConversation(svc: Svc, wsId: string): Promise<ConvoTurn[]> {
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const turns = (data?.goals as { conversation?: { turns?: unknown } } | null)?.conversation?.turns;
  return Array.isArray(turns) ? (turns as ConvoTurn[]) : [];
}

/** Append turns to the workspace's persistent thread (capped, timestamped). */
export async function appendConversation(svc: Svc, wsId: string, add: ConvoTurn[]): Promise<void> {
  const clean = add.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim());
  if (!clean.length) return;
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const prev = Array.isArray(goals.conversation?.turns) ? (goals.conversation.turns as ConvoTurn[]) : [];
  const now = new Date().toISOString();
  const stamped = clean.map((t) => ({ role: t.role, text: t.text.slice(0, 2000), at: t.at ?? now }));
  const turns = [...prev, ...stamped].slice(-MAX_TURNS);
  await svc.from("workspace").update({ goals: { ...goals, conversation: { turns, at: now } } }).eq("id", wsId).then(() => {}, () => {});
}

/** Recent turns as plain {role,text} for the answer engine's context window. */
export function recentTurns(turns: ConvoTurn[], n = 10): WaTurn[] {
  return turns.slice(-n).map((t) => ({ role: t.role, text: t.text }));
}
