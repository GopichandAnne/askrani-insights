import { createServiceClient, type RlsClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";
import { generateEdge } from "@/lib/intel";
import { generateBriefing } from "@/lib/briefing";
import { generateLocalTrends } from "@/lib/trending";
import { generateNewsDigest } from "@/lib/newsdigest";

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
  // beats speed. Four concurrent report-builds + LLM calls contend (DB/model) and
  // some fail; one at a time each completes cleanly. Persist after each so a
  // mid-run function timeout still saves what finished.
  const steps: [string, () => Promise<unknown>][] = [
    ["briefing", () => generateBriefing(row, db)],
    ["edge", () => generateEdge(row, db)],
    ["localTrends", () => generateLocalTrends(row, 60, db)],
    ["newsDigest", () => generateNewsDigest(row, db)],
  ];
  for (const [key, run] of steps) {
    try {
      const value = await run();
      const { data: cur } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
      await svc
        .from("workspace")
        .update({ goals: { ...((cur?.goals as object) ?? {}), [key]: value } })
        .eq("id", workspaceId);
    } catch {
      /* one failing never blocks the others; readers regenerate on demand */
    }
  }
}
