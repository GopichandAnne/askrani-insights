import { createServiceClient } from "@/lib/supabase/server";
import type { WaTurn } from "@/lib/assistant";

/**
 * WhatsApp conversation state, keyed by the sender's phone number. Lets the two-way
 * assistant be conversational: it remembers which business is active (for owners
 * who watch several), keeps a short thread so follow-ups stay in context, and holds
 * a pending disambiguation. Stored under organization.settings.waSessions (same
 * JSONB pattern as billing — no migration), pruned + TTL'd so it can't grow forever.
 */

export interface WaSession {
  workspaceId?: string;                                    // the business the thread is currently about
  pending?: { candidateIds: string[]; question?: string }; // awaiting a "which business?" reply
  history: WaTurn[];                                        // recent turns (capped)
  at: string;                                              // last activity (ISO)
}

const TTL_MS = 24 * 3600_000; // a session lives ~24h idle (mirrors WhatsApp's window)
const HISTORY_TURNS = 8;
const MAX_SESSIONS = 500;

type Svc = ReturnType<typeof createServiceClient>;

export async function readWaSession(svc: Svc, orgId: string, phone: string): Promise<WaSession | null> {
  const { data } = await svc.from("organization").select("settings").eq("id", orgId).maybeSingle();
  const sessions = ((data?.settings as any)?.waSessions ?? {}) as Record<string, WaSession>;
  const s = sessions[phone];
  if (!s) return null;
  if (Date.now() - new Date(s.at).getTime() > TTL_MS) return null;
  return { ...s, history: Array.isArray(s.history) ? s.history : [] };
}

export async function writeWaSession(svc: Svc, orgId: string, phone: string, session: WaSession): Promise<void> {
  const { data } = await svc.from("organization").select("settings").eq("id", orgId).maybeSingle();
  const settings = ((data?.settings as Record<string, any>) ?? {}); // preserve billing + other keys
  const sessions = { ...((settings.waSessions as Record<string, WaSession>) ?? {}) };
  sessions[phone] = {
    workspaceId: session.workspaceId,
    pending: session.pending,
    history: session.history.slice(-HISTORY_TURNS),
    at: new Date().toISOString(),
  };

  // prune expired + cap the map so it never grows unbounded
  const live = Object.entries(sessions)
    .filter(([, v]) => Date.now() - new Date(v.at).getTime() <= TTL_MS)
    .sort((a, b) => new Date(b[1].at).getTime() - new Date(a[1].at).getTime())
    .slice(0, MAX_SESSIONS);
  await svc.from("organization").update({ settings: { ...settings, waSessions: Object.fromEntries(live) } }).eq("id", orgId);
}
