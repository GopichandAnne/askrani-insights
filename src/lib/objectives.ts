import { createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { buildWorkspaceReport } from "@/lib/report";
import { buildScorecard } from "@/lib/scorecard";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Proactive OBJECTIVES — a self-grading action plan. Daily/weekly/monthly goals
 * generated from where the business LAGS (scorecard gaps vs the market leader),
 * what competitors are doing (market_event log), the occasion calendar for its
 * vertical/date, and unmet demand — each tied to a MACHINE-CHECKABLE metric so we
 * auto-detect completion from data (no self-reporting). Vertical-agnostic: the LLM
 * frames the actions for the business's industry; grading is metric-driven.
 * Cached on workspace.goals.objectives; refreshed + regraded from the warm hook.
 */

export type Horizon = "daily" | "weekly" | "monthly";
// metrics we can measure from data → auto-grade. "manual" = shown, not auto-graded.
export type Metric = "rating" | "reviews" | "posts7d" | "followers" | "findabilityScore" | "findabilityTop3" | "aiScore" | "pricesPublished" | "manual";
export type Op = "gte" | "plus"; // gte: current ≥ target; plus: current ≥ baseline + target

export interface Objective {
  id: string; horizon: Horizon; title: string; why: string;
  metric: Metric; op: Op; target: number; baseline: number;
  status: "open" | "done"; createdAt: string; completedAt?: string;
}
export interface ObjectivesReport { at: string; items: Objective[]; completedTotal: number; empty?: boolean }

const HORIZON_DAYS: Record<Horizon, number> = { daily: 1, weekly: 7, monthly: 30 };

/** Current value of every gradeable metric for the target business. */
async function measure(ws: WorkspaceRow, svc: any): Promise<Record<string, number>> {
  const m: Record<string, number> = {};
  const [report, { data: wRow }, ids] = await Promise.all([
    buildWorkspaceReport(ws, 30, svc),
    svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle(),
    workspaceBusinessIds(ws, svc),
  ]);
  const you = report.reputation.find((r: any) => r.isTarget);
  m.rating = you?.rating ?? 0;
  m.reviews = you?.reviewCount ?? 0;
  const g = (wRow?.goals ?? {}) as any;
  m.findabilityScore = g.findability?.score ?? 0;
  m.findabilityTop3 = g.findability?.coverage?.inTop3 ?? 0;
  m.aiScore = g.aiFindability && !g.aiFindability.empty ? (g.aiFindability.score ?? 0) : 0;
  // your social followers (latest per channel, summed)
  const tl = ((g.socialTimeline ?? {})[ws.name] ?? []) as { date: string; channel: string; followers?: number }[];
  const latest = new Map<string, { d: string; f: number }>();
  for (const p of tl) { if (p.followers == null) continue; const e = latest.get(p.channel); if (!e || p.date > e.d) latest.set(p.channel, { d: p.date, f: p.followers }); }
  m.followers = [...latest.values()].reduce((a, b) => a + b.f, 0);
  if (ids.targetId) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { count: posts } = await svc.from("content_item").select("id", { count: "exact", head: true }).eq("business_id", ids.targetId).in("platform", ["instagram", "facebook", "tiktok"]).gte("published_at", since);
    m.posts7d = posts ?? 0;
    const { count: pc } = await svc.from("offer").select("id", { count: "exact", head: true }).eq("business_id", ids.targetId);
    m.pricesPublished = pc ?? 0;
  }
  return m;
}

const isDone = (o: Objective, cur: Record<string, number>): boolean => {
  if (o.metric === "manual") return o.status === "done";
  const v = cur[o.metric] ?? 0;
  return o.op === "plus" ? v >= o.baseline + o.target : v >= o.target;
};

const GEN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    objectives: {
      type: "array", maxItems: 8,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          horizon: { type: "string", enum: ["daily", "weekly", "monthly"] },
          title: { type: "string", description: "the action, imperative and specific (e.g. 'Post a hero-dish reel', 'Ask 5 happy customers for a Google review')" },
          why: { type: "string", description: "one line: the gap/competitor/occasion this targets, with the number" },
          metric: { type: "string", description: "which signal proves it's done — one of: rating, reviews, weekly posts, followers, findability score, findability top-3, AI search score, prices published — or 'manual' if none fits" },
          target: { type: "number", description: "the number to hit — an absolute value (e.g. rating 4.6, 3 posts/week) or, for reviews/followers, how many MORE to gain" },
        },
        required: ["horizon", "title", "why", "metric", "target"],
      },
    },
  },
  required: ["objectives"],
};

const GEN_SYSTEM =
  "You are an expert local-business coach. Produce a concrete, prioritized action plan that CLOSES this business's biggest gaps versus its market — some daily (quick, repeatable), some weekly, some monthly (bigger). Draw the objectives from: (1) the SCORECARD gaps — where you trail the market average and the category LEADER; (2) COMPETITOR MOVES (what rivals are running); (3) the OCCASION CALENDAR — upcoming holidays/festivals/seasonal moments relevant to THIS vertical and locale, given today's date; (4) UNMET DEMAND and offerings the market wins with that you lack. Tailor everything to the business's vertical (dishes vs products vs treatments vs listings) — never generic, never assume restaurant. For EACH objective name the metric that best proves completion (rating, reviews, weekly posts, followers, findability score, findability top-3, AI search score, prices published — or 'manual') and a realistic target number. Return ~2 daily, ~3 weekly, ~2 monthly, hardest-hitting first.";

// Map the model's natural metric label → a machine-checkable key; op is derived
// (reviews/followers grow from a baseline; the rest are absolute targets to reach).
function mapMetric(s: string): Metric {
  const t = String(s ?? "").toLowerCase();
  if (/top.?3|top.?three/.test(t)) return "findabilityTop3";
  if (/rating|star/.test(t)) return "rating";
  if (/review/.test(t)) return "reviews";
  if (/post|reel|content|cadence/.test(t)) return "posts7d";
  if (/follow/.test(t)) return "followers";
  if (/\bai\b|chatgpt|perplex/.test(t)) return "aiScore";
  if (/findab|google|search rank|\brank\b/.test(t)) return "findabilityScore";
  if (/price|menu online|publish/.test(t)) return "pricesPublished";
  return "manual";
}
const opFor = (m: Metric): Op => (m === "reviews" || m === "followers") ? "plus" : "gte";

async function generate(ws: WorkspaceRow, svc: any, cur: Record<string, number>): Promise<Objective[]> {
  if (!isLlmConfigured()) return [];
  const [{ data: wRow }, scorecard] = await Promise.all([
    svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle(),
    buildScorecard(ws, svc),
  ]);
  const g = (wRow?.goals ?? {}) as any;
  const { data: mevents } = await svc.from("market_event").select("kind,rival,title").eq("workspace_id", ws.id).order("first_seen_on", { ascending: false }).limit(15);
  const clip = (s: any, n = 120) => (s == null ? undefined : String(s).slice(0, n));
  const ctx = {
    businessType: ws.vertical,
    today: new Date().toISOString().slice(0, 10),
    scorecard: scorecard.empty ? null : { rank: scorecard.composite.rank, of: scorecard.composite.total, metrics: scorecard.metrics.map((mm: any) => ({ metric: mm.label, you: mm.you, marketAvg: mm.avg, leader: mm.bestName, leaderScore: mm.best })) },
    yourCurrentMetrics: cur,
    competitorMoves: (mevents ?? []).map((e: any) => ({ kind: e.kind, rival: e.rival, what: clip(e.title) })),
    unmetDemand: (g.demand?.demands ?? []).slice(0, 5).map((x: any) => x.need),
    whatsWinningYouLack: (g.winning?.winning ?? []).filter((x: any) => x.onYourMenu === false).slice(0, 5).map((x: any) => x.name),
  };
  try {
    const { data } = await getLlm().callStructured<{ objectives: any[] }>({
      system: GEN_SYSTEM, text: `DATA:\n${JSON.stringify(ctx)}\n\nBuild the plan.`, schema: GEN_SCHEMA, tier: "extract", maxTokens: 1600,
    });
    const now = new Date().toISOString();
    return (data?.objectives ?? []).slice(0, 8).map((o: any, i: number) => {
      const metric = mapMetric(o.metric);
      return {
        id: `${now.slice(0, 10)}-${i}`, horizon: (["daily", "weekly", "monthly"].includes(o.horizon) ? o.horizon : "weekly") as Horizon,
        title: String(o.title ?? "").slice(0, 140), why: String(o.why ?? "").slice(0, 200),
        metric, op: opFor(metric), target: Number(o.target) || 1,
        baseline: cur[metric] ?? 0, status: "open" as const, createdAt: now,
      };
    }).filter((o: Objective) => o.title);
  } catch { return []; }
}

/**
 * Refresh objectives: grade the open ones against fresh data (auto-complete), then
 * regenerate a per-horizon set when it's due (or empty). Persists goals.objectives.
 */
export async function refreshObjectives(ws: WorkspaceRow, db?: any): Promise<ObjectivesReport> {
  const at = new Date().toISOString();
  const svc = db ?? createServiceClient();
  const { data: wRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (wRow?.goals ?? {}) as any;
  const prev: ObjectivesReport = goals.objectives ?? { at, items: [], completedTotal: 0 };
  const cur = await measure(ws, svc);

  // 1) grade existing open objectives against fresh data
  const graded = (prev.items ?? []).map((o) => (o.status === "open" && o.metric !== "manual" && isDone(o, cur) ? { ...o, status: "done" as const, completedAt: at } : o));

  // 2) regenerate the horizons that are due (stale) or have no open items left
  const now = Date.now();
  const dueHorizon = (h: Horizon) => {
    const open = graded.filter((o) => o.horizon === h && o.status === "open");
    if (!open.length) return true; // all done (or none) → refresh this horizon
    const oldest = Math.min(...open.map((o) => new Date(o.createdAt).getTime()));
    return now - oldest >= HORIZON_DAYS[h] * 86_400_000;
  };
  let items = graded;
  if ((["daily", "weekly", "monthly"] as Horizon[]).some(dueHorizon)) {
    const fresh = await generate(ws, svc, cur);
    if (fresh.length) {
      const keep = graded.filter((o) => o.status === "done" || !dueHorizon(o.horizon)); // keep recent done + not-yet-due horizons
      const refreshedHorizons = new Set((["daily", "weekly", "monthly"] as Horizon[]).filter(dueHorizon));
      items = [...keep, ...fresh.filter((o) => refreshedHorizons.has(o.horizon))].slice(-24);
    }
  }

  // 3) final grade pass over EVERYTHING (incl. freshly-generated) so an objective
  //    the data already satisfies shows done immediately; count new completions.
  const wasOpen = new Set((prev.items ?? []).filter((o) => o.status === "open").map((o) => o.id));
  let newlyDone = 0;
  items = items.map((o) => {
    if (o.status === "open" && o.metric !== "manual" && isDone(o, cur)) { if (wasOpen.has(o.id)) newlyDone++; return { ...o, status: "done" as const, completedAt: at }; }
    return o;
  });
  const completedTotal = (prev.completedTotal ?? 0) + newlyDone;

  const report: ObjectivesReport = { at, items, completedTotal, ...(items.length ? {} : { empty: true }) };
  const { data: c2 } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((c2?.goals as object) ?? goals), objectives: report } }).eq("id", ws.id);
  return report;
}

/** Cached read for the UI (never regenerates). */
export async function getObjectives(ws: WorkspaceRow): Promise<ObjectivesReport | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  return ((data?.goals as any)?.objectives as ObjectivesReport | undefined) ?? null;
}
