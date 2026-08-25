import { createServiceClient, type RlsClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";
import { generateEdge } from "@/lib/intel";
import { generateBriefing } from "@/lib/briefing";
import { generateLocalTrends } from "@/lib/trending";
import { generateNewsDigest } from "@/lib/newsdigest";
import { generateYou, youIsGood } from "@/lib/you";
import { generateContent, contentIsGood } from "@/lib/content";
import { generateWinning, winningIsGood } from "@/lib/winning";
import { generateDemand, demandIsGood } from "@/lib/demand";
import { buildMenuLens } from "@/lib/menu";
import { generateDeals, dealsIsGood } from "@/lib/deals";
import { generateReviewPulse, pulseIsGood } from "@/lib/pulse";
import { generateSocialPulse, socialPulseIsGood } from "@/lib/socialpulse";
import { snapshotMarket, recordMarketEvents } from "@/lib/panel";
import { buildPriceCanon } from "@/lib/pricecanon";
import { refreshObjectives } from "@/lib/objectives";

/**
 * Warm the workspace's synthesis caches AFTER collection finishes, so the owner's
 * first visit to "This Week" / "Around me" is instant instead of triggering a
 * ~40s edge generation on the request path. Runs in the worker (no user session),
 * so it uses the service-role client for reads (bypasses RLS) and writes the
 * results into workspace.goals — the same cache the getOrMake* readers use.
 *
 * Each generation is independent + best-effort: one failing never blocks the
 * others, and a stale-but-present cache is fine (the reader regenerates when old).
 */
export async function warmWorkspaceSynthesis(workspaceId: string): Promise<void> {
  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("*").eq("id", workspaceId).maybeSingle();
  if (!ws) return;
  const row = ws as WorkspaceRow;
  // The service client has the same query API as the RLS client but a distinct
  // generic type; the read helpers accept the RLS type, so cast at this boundary.
  const db = svc as unknown as RlsClient;

  // Sequential, not parallel: this runs in the background worker, so reliability
  // beats speed (parallel report-builds + LLM calls contend and some fail).
  // Each step retries a few times — the generators catch LLM failures internally
  // and return a fallback, so we detect that fallback via `good()` and re-run
  // rather than caching an empty surface. Persist after each so a mid-run timeout
  // still saves what finished.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Edge FIRST — it's the priority (the ~40s surface) and running it before any
  // Anthropic rate-limit budget is consumed by the others gives it the best shot.
  const steps: { key: string; run: () => Promise<any>; good: (v: any) => boolean }[] = [
    { key: "edge", run: () => generateEdge(row, db), good: (v) => !!v?.headline && !/Collect your market|Connect an AI key/.test(v.headline) },
    { key: "you", run: () => generateYou(row, db), good: (v) => youIsGood(v) },
    { key: "briefing", run: () => generateBriefing(row, db), good: (v) => !!v?.summary },
    { key: "newsDigest", run: () => generateNewsDigest(row, db), good: (v) => !!(v?.items?.length || v?.empty) && !v?.failed },
    { key: "localTrends", run: () => generateLocalTrends(row, 60, db), good: (v) => !!(v?.trends?.length || (v?.empty && !v?.failed)) },
    { key: "content", run: () => generateContent(row, 90, db), good: (v) => contentIsGood(v) && !v?.failed },
    { key: "winning", run: () => generateWinning(row, db), good: (v) => winningIsGood(v) && !v?.failed },
    { key: "demand", run: () => generateDemand(row, db), good: (v) => demandIsGood(v) && !v?.failed },
    { key: "menu", run: () => buildMenuLens(row, db), good: (v) => !!v && !v?.failed }, // retry when the intelligent match errored
    { key: "deals", run: () => generateDeals(row, db), good: (v) => dealsIsGood(v) && !v?.failed },
    // Pulse LAST — it reads goals.you (velocity) + writes goals.themeHistory, so it
    // must run after You is cached; this builds the week-over-week theme diff.
    { key: "pulse", run: () => generateReviewPulse(row, db), good: (v) => pulseIsGood(v) && !v?.failed },
    { key: "socialPulse", run: () => generateSocialPulse(row, db), good: (v) => socialPulseIsGood(v) && !v?.failed },
  ];
  for (const { key, run, good } of steps) {
    let value: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        value = await run();
        if (good(value)) break; // got a real result
      } catch { /* fall through to retry */ }
      if (attempt < 2) await sleep(8000); // transient (model overload / rate limit) — back off
    }
    if (value == null) continue;
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
    await svc
      .from("workspace")
      .update({ goals: { ...((cur?.goals as object) ?? {}), [key]: value } })
      .eq("id", workspaceId);
    await sleep(2000); // small gap between surfaces to avoid a rate-limit burst
  }

  // Bank today's append-only market-panel snapshot now that every pillar is
  // fresh. Best-effort: the panel is a data asset, never blocks warm.
  try {
    await snapshotMarket(row, db);
  } catch {
    /* non-fatal — next cycle captures it */
  }
  // Refresh the price canonical map (intelligent like-for-like matching for the
  // scorecard Price basket). Best-effort — the scorecard falls back to the
  // deterministic matcher if this is stale/absent.
  try {
    await buildPriceCanon(row, db);
  } catch {
    /* non-fatal — deterministic basket still works */
  }
  // Grade + refresh the proactive objectives LAST — it depends on the freshly
  // synthesized pillars + scorecard above (auto-completes what the data now shows).
  try {
    await refreshObjectives(row, db);
  } catch {
    /* non-fatal — objectives just won't update this cycle */
  }
  // Preserve this cycle's artifacts (deals/ad-moves/breakouts/formats/demand) in
  // the append-only event log, so seasonality is queryable over time.
  try {
    await recordMarketEvents(row, db);
  } catch {
    /* non-fatal — next cycle captures it */
  }
}
