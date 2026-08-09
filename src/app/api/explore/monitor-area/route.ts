import { NextResponse, after } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { exploreArea } from "@/lib/explore";
import { createAreaWorkspace } from "@/lib/discovery";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";
import { quoteAreaMonitor, spendCredits, refundCredits, getBalance } from "@/lib/credits";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Monitor an AREA (no business of your own). Re-scans the area server-side (never
 * trusts a client-supplied list), creates an area-subject workspace with every
 * found business attached as a peer, and enqueues the first collection. This is
 * the "Explore → Monitor this area" handoff for owners who don't want to nominate
 * their own business. Signed-in only (monitoring runs on credits downstream).
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const area = String(body.area ?? "").trim().slice(0, 80);
  const keyword = String(body.keyword ?? "").trim().slice(0, 60);
  if (area.length < 2) return badRequest("Enter a zip code or city.");

  const { results, center } = await exploreArea({ area, keyword });
  if (!results.length) return NextResponse.json({ error: "No businesses found in that area." }, { status: 404 });

  // Workspace vertical = the most common one among the found businesses.
  const tally = new Map<string, number>();
  for (const r of results) tally.set(r.vertical, (tally.get(r.vertical) ?? 0) + 1);
  const vertical = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "restaurant";

  const businesses = results.slice(0, 15).map((r) => ({
    name: r.name,
    website: r.website,
    geo: r.geo,
    category: r.category,
    vertical: r.vertical,
  }));

  // Authoritative up-front charge, priced on the real business count we'll watch.
  // Gated: if the balance is short, don't create anything — tell the client to top up.
  const quote = quoteAreaMonitor(businesses.length);
  const charged = await spendCredits(auth.orgId, quote, "area_monitor_start", { area, keyword, businessCount: businesses.length });
  if (!charged) return NextResponse.json({ needsCredits: true, quote, balance: await getBalance(auth.orgId) }, { status: 402 });

  try {
    const { workspaceId, count } = await createAreaWorkspace(auth.orgId, { area, keyword: keyword || null, vertical, center: center ?? null, businesses });
    // Record the start charge on the workspace for reference (mirrors deep-read).
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
    await svc.from("workspace").update({ goals: { ...((cur?.goals as Record<string, unknown>) ?? {}), areaMonitorCharged: quote, areaMonitorStartedAt: new Date().toISOString() } }).eq("id", workspaceId);
    const enqueued = await enqueueWorkspaceCollection(workspaceId);
    void logEvent("monitor_area", { area, keyword, count, enqueued, quote }, { orgId: auth.orgId, path: "/explore" });
    after(() => nudgeWorker());
    return NextResponse.json({ workspaceId, count, quote, balance: await getBalance(auth.orgId) });
  } catch (e) {
    // Creation failed after charging — refund so we never take credits for nothing.
    await refundCredits(auth.orgId, quote, "area_monitor_refund", { area, keyword, error: (e as Error).message });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
