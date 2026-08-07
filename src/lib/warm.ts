import { createServiceClient, type RlsClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";
import { generateEdge } from "@/lib/intel";
import { generateBriefing } from "@/lib/briefing";
import { generateLocalTrends } from "@/lib/trending";
import { generateNewsDigest } from "@/lib/newsdigest";
import { generateYou, youIsGood } from "@/lib/you";

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
    { key: "newsDigest", run: () => generateNewsDigest(row, db), good: (v) => !!(v?.items?.length || v?.empty) },
    { key: "localTrends", run: () => generateLocalTrends(row, 60, db), good: (v) => !!(v?.trends?.length || (v?.empty && !v?.failed)) },
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
}
