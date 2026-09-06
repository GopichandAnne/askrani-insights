import { createServiceClient } from "@/lib/supabase/server";
import { buildAttention, type AttentionItem, type AttentionBoard, type AttnKind } from "@/lib/attention";
import type { AttnMode } from "@/lib/attention-prefs";

/**
 * Real-time trigger alerts — the painkiller layer on top of the (weekly) brief.
 *
 * The weekly digest fires on a plan clock regardless of what changed. An ALERT is
 * different: it fires the moment a genuinely NEW, high-impact signal appears —
 * a competitor cut a price, launched a deal, you slipped on a key search — instead
 * of waiting for the next digest. It reuses the SAME material-signal detector as
 * the brief (buildAttention: class-A, competitor-&-pricing-first, deterministic),
 * so alerts and the brief can never disagree. This module only decides WHAT to
 * alert on and WHEN; the cron (/api/alerts/tick) does the sending.
 *
 * Trust is the whole game — an owner blasted with noise churns. So alerts are
 * bounded four ways: only class-A URGENT kinds; a per-signal cooldown (never the
 * same change twice); a min gap + per-day cap per workspace; and a first-run
 * BASELINE seed so we alert on what changes AFTER we start watching, not on the
 * backlog that already existed. The owner's attention MODE (quiet/balanced/active)
 * scales the volume, and goals.alertsOptOut turns it off entirely.
 */

// Kinds urgent enough to interrupt in real time (competitor, pricing, reputation, search).
const URGENT_KINDS = new Set<AttnKind>([
  "competitor_price", "your_pricing", "competitor_deal", "competitor_launch", "reputation", "findability",
]);

// Per attention-mode policy. Quiet interrupts rarely and only for the most urgent;
// active surfaces more. minScore filters by the attention score (see attention.ts
// KIND_WEIGHT + CLS_BASE): ~130 keeps quiet to competitor_price / your_pricing.
const ALERT_POLICY: Record<AttnMode, { maxPerDay: number; cap: number; minScore: number }> = {
  quiet: { maxPerDay: 1, cap: 1, minScore: 130 },
  balanced: { maxPerDay: 2, cap: 2, minScore: 0 },
  active: { maxPerDay: 4, cap: 3, minScore: 0 },
};
const MIN_GAP_MS = 6 * 3_600_000; // ≥6h between alert pushes to one workspace
const COOLDOWN_DAYS = 21;         // never re-alert the same signal within this window
const LOG_CAP = 40;

export interface AlertsSeen { [id: string]: string } // signal id → last-alerted ISO
export interface AlertLogEntry { at: string; ids: string[]; headline: string; channels: string[] }

export interface AlertDecision {
  alerts: AttentionItem[]; // items to push now (possibly empty)
  board: AttentionBoard;   // the full board (context for delivery)
  skipped: string;         // reason nothing fired (for observability)
  baseline?: string[];     // first run only: seed these ids as "already seen" (no send)
}

/** Drop cooldown-expired ids so alertsSeen can't grow forever. */
function prune(seen: AlertsSeen, nowMs: number): AlertsSeen {
  const cutoff = nowMs - COOLDOWN_DAYS * 86_400_000;
  const out: AlertsSeen = {};
  for (const [id, iso] of Object.entries(seen)) if (Date.parse(iso) >= cutoff) out[id] = iso;
  return out;
}

const urgentCandidates = (board: AttentionBoard): AttentionItem[] =>
  [...board.items, ...board.more].filter((it) => it.cls === "A" && URGENT_KINDS.has(it.kind));

/**
 * Pure decision — given a workspace's cached goals + now, what should we alert on?
 * No I/O; the cron applies the result. Same goals in → same decision out.
 */
export function decideAlerts(
  ws: { name: string; vertical: string },
  goals: Record<string, any>,
  now: Date = new Date(),
): AlertDecision {
  const nowMs = now.getTime();
  const board = buildAttention(ws, goals, (goals.attentionSeen?.ids as string[]) ?? [], now);

  if (goals.alertsOptOut === true) return { alerts: [], board, skipped: "opted out" };

  // First run: establish the baseline WITHOUT alerting, so we only fire on changes
  // that happen after Rani starts watching — never on the pre-existing backlog.
  if (goals.alertsSeen === undefined) {
    return { alerts: [], board, skipped: "seeding baseline", baseline: urgentCandidates(board).map((i) => i.id) };
  }

  const mode: AttnMode = board.mode ?? "balanced";
  const policy = ALERT_POLICY[mode];

  const lastAt = goals.lastAlertAt ? Date.parse(goals.lastAlertAt) : 0;
  if (lastAt && nowMs - lastAt < MIN_GAP_MS) return { alerts: [], board, skipped: "within min gap" };

  const log = (goals.alertLog ?? []) as AlertLogEntry[];
  const dayAgo = nowMs - 86_400_000;
  const sentToday = log.filter((e) => Date.parse(e.at) >= dayAgo).reduce((n, e) => n + (e.ids?.length ?? 0), 0);
  const remaining = Math.max(0, policy.maxPerDay - sentToday);
  if (remaining <= 0) return { alerts: [], board, skipped: "daily cap reached" };

  const seen = prune((goals.alertsSeen ?? {}) as AlertsSeen, nowMs);
  const alerts = urgentCandidates(board)
    .filter((it) => it.score >= policy.minScore && !seen[it.id]) // NEW (not alerted, not in cooldown)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(policy.cap, remaining));

  return { alerts, board, skipped: alerts.length ? "" : "no new urgent signals" };
}

/** Shape the alert items into a compact board for the existing brief/WhatsApp senders. */
export function alertBoard(board: AttentionBoard, alerts: AttentionItem[]): AttentionBoard {
  const n = alerts.length;
  return {
    ...board,
    headline: n === 1 ? "Act now — 1 urgent change in your market" : `Act now — ${n} urgent changes in your market`,
    statusLine: alerts.map((a) => a.category).join(" · "),
    items: alerts,
    more: [],
  };
}

/** First-run: record the current urgent signals as already-seen, no send. */
export async function seedAlertBaseline(wsId: string, ids: string[], now: Date = new Date()): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const nowIso = now.toISOString();
  const seen: AlertsSeen = {};
  for (const id of ids) seen[id] = nowIso;
  await svc.from("workspace").update({ goals: { ...goals, alertsSeen: seen } }).eq("id", wsId).then(() => {}, () => {});
}

/** After sending: stamp the alerted ids (cooldown), the push time (min gap), and the log. */
export async function markAlerted(wsId: string, alerts: AttentionItem[], channels: string[], now: Date = new Date()): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const nowIso = now.toISOString();
  const seen = prune({ ...((goals.alertsSeen as AlertsSeen) ?? {}) }, now.getTime());
  for (const a of alerts) seen[a.id] = nowIso;
  const entry: AlertLogEntry = { at: nowIso, ids: alerts.map((a) => a.id), headline: alerts[0]?.headline ?? "", channels };
  const log = [entry, ...((goals.alertLog as AlertLogEntry[]) ?? [])].slice(0, LOG_CAP);
  await svc.from("workspace").update({ goals: { ...goals, alertsSeen: seen, lastAlertAt: nowIso, alertLog: log } }).eq("id", wsId);
}
