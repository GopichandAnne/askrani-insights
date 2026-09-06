import { createServiceClient } from "@/lib/supabase/server";
import type { WaTurn } from "@/lib/assistant";

/**
 * Persistent conversation memory — a durable thread PER PARTICIPANT within a
 * workspace, so each person has their own continuous chat (the owner and a team
 * member on the same business don't share a thread). Keyed by:
 *   • web      → the signed-in auth user id
 *   • WhatsApp → "wa:<phone>" (the sender's number)
 * Stored on goals.conversations = { [participantId]: { turns, at } } (JSONB, no
 * migration), capped per person and pruned to the most-recently-active people so
 * it can't grow unbounded. The workspace's collected DATA is the deep memory; this
 * is each person's transcript on top of it.
 */
export type ConvoTurn = WaTurn & { at?: string };
interface Thread { turns: ConvoTurn[]; at: string }
const MAX_TURNS = 40;          // ~20 exchanges kept per person
const MAX_PARTICIPANTS = 50;   // most-recently-active people kept per workspace

type Svc = ReturnType<typeof createServiceClient>;

/** WhatsApp participant id from a phone number. */
export const waParticipant = (phone: string): string => `wa:${phone}`;

/** One participant's stored thread (oldest → newest). */
export async function readConversation(svc: Svc, wsId: string, participantId: string): Promise<ConvoTurn[]> {
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const map = (data?.goals as { conversations?: Record<string, Thread> } | null)?.conversations ?? {};
  const turns = map[participantId]?.turns;
  return Array.isArray(turns) ? turns : [];
}

/** Append turns to a participant's thread (capped per person + pruned across people). */
export async function appendConversation(svc: Svc, wsId: string, participantId: string, add: ConvoTurn[]): Promise<void> {
  const clean = add.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim());
  if (!clean.length) return;
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const map: Record<string, Thread> = { ...((goals.conversations as Record<string, Thread>) ?? {}) };
  const now = new Date().toISOString();
  const prev = Array.isArray(map[participantId]?.turns) ? map[participantId].turns : [];
  const stamped = clean.map((t) => ({ role: t.role, text: t.text.slice(0, 2000), at: t.at ?? now }));
  map[participantId] = { turns: [...prev, ...stamped].slice(-MAX_TURNS), at: now };

  // keep only the most-recently-active participants
  const live = Object.entries(map)
    .sort((a, b) => new Date(b[1].at).getTime() - new Date(a[1].at).getTime())
    .slice(0, MAX_PARTICIPANTS);
  await svc.from("workspace").update({ goals: { ...goals, conversations: Object.fromEntries(live) } }).eq("id", wsId).then(() => {}, () => {});
}

/** Recent turns as plain {role,text} for the answer engine's context window. */
export function recentTurns(turns: ConvoTurn[], n = 10): WaTurn[] {
  return turns.slice(-n).map((t) => ({ role: t.role, text: t.text }));
}
