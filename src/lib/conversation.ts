import { createServiceClient } from "@/lib/supabase/server";
import type { WaTurn } from "@/lib/assistant";

/**
 * Persistent conversation memory — a durable thread PER PERSON within a workspace,
 * so each person has their own continuous chat (the owner and a team member on the
 * same business don't share a thread). Keyed by the person's AUTH USER id:
 *   • web      → the signed-in auth user id
 *   • WhatsApp → the account whose phone matches the sender (resolveWaParticipant)
 * so the SAME person's web and WhatsApp threads are ONE thread. A WhatsApp number
 * with no matching account falls back to "wa:<phone>" (a stable per-number thread).
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

/** Fallback WhatsApp participant id for a number with no matching account. */
export const waParticipant = (phone: string): string => `wa:${phone}`;

/**
 * Unified participant id for a WhatsApp sender within an org. Returns the AUTH USER
 * id when the sender's number matches a member of the org — so their WhatsApp and
 * web assistant threads are ONE person's thread (every account carries a phone).
 * Falls back to "wa:<phone>" for numbers with no account. Resolves within the org's
 * membership only (cheap — the sender who operates the business is a member of it),
 * matching on exact digits or the last 9 to tolerate country-code formatting.
 */
export async function resolveWaParticipant(svc: Svc, orgId: string, phone: string): Promise<string> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 8 && orgId) {
    const { data: rows } = await svc.from("org_membership").select("user_id").eq("organization_id", orgId);
    for (const r of (rows ?? []) as { user_id: string }[]) {
      try {
        const { data } = await (svc as any).auth.admin.getUserById(r.user_id);
        const p = String(data?.user?.phone ?? "").replace(/\D/g, "");
        if (p && (p === digits || p.slice(-9) === digits.slice(-9))) return r.user_id;
      } catch { /* try the next member */ }
    }
  }
  return waParticipant(phone);
}

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
