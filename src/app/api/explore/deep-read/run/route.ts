import { NextResponse, after } from "next/server";
import { requireOrg, unauthorized, badRequest, workspaceInOrg } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { spendCredits, getBalance } from "@/lib/credits";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * Deep read — step 2 (RUN). The owner has seen the exact quote and confirmed.
 * Charge the credits (explicit, up-front — this is the first paid action), then
 * enqueue the one-shot collection and nudge the worker. Idempotent: a second call
 * on an already-charged deep read re-enqueues without double-charging.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { workspaceId } = await req.json().catch(() => ({}));
  if (!workspaceId) return badRequest("workspaceId required");
  if (!(await workspaceInOrg(workspaceId, auth.orgId))) return unauthorized();

  const svc = createServiceClient();
  const { data: row } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
  const goals = (row?.goals as Record<string, any>) ?? {};
  if (!goals.ephemeral) return badRequest("not a deep-read workspace");
  const quote = Number(goals.deepReadQuote ?? 0);

  try {
    if (!goals.deepReadCharged) {
      const ok = await spendCredits(auth.orgId, quote, "deep_read", { workspaceId, scope: goals.deepReadScope });
      if (!ok) return NextResponse.json({ needsCredits: true, quote, balance: await getBalance(auth.orgId) });
      await svc.from("workspace").update({
        goals: { ...goals, deepReadCharged: quote, deepReadRunAt: new Date().toISOString() },
      }).eq("id", workspaceId);
    }
    const enqueued = await enqueueWorkspaceCollection(workspaceId);
    void logEvent("deep_read_run", { workspaceId, quote, enqueued }, { orgId: auth.orgId });
    after(() => nudgeWorker());
    return NextResponse.json({ enqueued, quote, balance: await getBalance(auth.orgId) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
