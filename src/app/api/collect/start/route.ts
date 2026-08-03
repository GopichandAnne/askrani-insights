import { NextResponse, after } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { enqueueWorkspaceCollection, nudgeWorker, requeuePausedForOrg } from "@/lib/jobs";
import { hasCredits, getBalance } from "@/lib/credits";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * Start collection for a workspace — explicit human action. Onboarding no longer
 * auto-scrapes; the user curates the competitor set first, then calls this to
 * enqueue the target + all competitors and kick the worker.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { workspaceId } = await req.json().catch(() => ({}));
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  try {
    // Phase 2 gate: monitoring runs on credits. Block enqueue when empty.
    if (!(await hasCredits(auth.orgId))) {
      return NextResponse.json({ enqueued: 0, needsCredits: true, balance: await getBalance(auth.orgId) });
    }
    await requeuePausedForOrg(auth.orgId); // reactivate anything paused earlier
    const enqueued = await enqueueWorkspaceCollection(workspaceId);
    void logEvent("collect_started", { workspaceId, enqueued }, { orgId: auth.orgId });
    // Nudge the worker so collection starts within seconds, not next cron tick.
    after(() => nudgeWorker());
    return NextResponse.json({ enqueued });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
