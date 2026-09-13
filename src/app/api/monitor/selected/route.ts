import { NextResponse, after } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { createAreaWorkspace } from "@/lib/discovery";
import { enqueueWorkspaceCollection, nudgeWorker } from "@/lib/jobs";
import { quoteAreaMonitor, spendCredits, refundCredits, getBalance } from "@/lib/credits";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Begin collecting for a VALIDATED, owner-curated set of businesses (the monitoring
 * queue). Unlike /explore/monitor-area (which re-scans an area and never trusts a
 * client list), this trusts the selection precisely because the owner just validated
 * each business + its handle in the queue UI — that human gate is the whole point.
 * Businesses are grouped per vertical into one workspace each (so the grocery and
 * restaurant detectors run cleanly), the confirmed Instagram handles are stored, and
 * the first collection is enqueued. Credits are charged once for the whole batch,
 * with a full refund if creation fails. Signed-in only.
 */
const clean = (s: unknown, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const cleanHandle = (s: unknown) => String(s ?? "").replace(/^@+/, "").replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 40);
const VERTS = new Set(["grocery", "restaurant", "salon", "smoke_vape", "fitness", "dental", "real_estate", "other"]);
const CHANS = ["instagram", "facebook", "tiktok", "youtube"] as const;

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  // Superadmin-only (founder/ops tool) — matches the page gate.
  if (!isSuperAdmin(await getUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const label = clean(body.label, 60) || "Austin, TX";
  const raw = Array.isArray(body.businesses) ? body.businesses : [];
  const businesses = raw
    .map((b: Record<string, unknown>) => {
      const rawH = (b.handles ?? {}) as Record<string, unknown>;
      const handles: Record<string, string> = {};
      for (const c of CHANS) { const h = cleanHandle(rawH[c] ?? (c === "instagram" ? b.handle ?? b.instagram : "")); if (h) handles[c] = h; }
      return {
        name: clean(b.name),
        website: b.website ? clean(b.website, 300) : undefined,
        vertical: VERTS.has(String(b.vertical)) ? String(b.vertical) : "restaurant",
        handles,
      };
    })
    .filter((b: { name: string }) => b.name.length > 1)
    .slice(0, 40);
  if (!businesses.length) return badRequest("Select at least one business to monitor.");

  // Group per vertical → one area workspace each (clean detector branches).
  const groups = new Map<string, typeof businesses>();
  for (const b of businesses) (groups.get(b.vertical) ?? groups.set(b.vertical, []).get(b.vertical)!).push(b);

  // Charge once, up front, on the whole batch. Gate on balance before creating anything.
  const quote = quoteAreaMonitor(businesses.length);
  const charged = await spendCredits(auth.orgId, quote, "monitor_selected_start", { label, businessCount: businesses.length, verticals: [...groups.keys()] });
  if (!charged) return NextResponse.json({ needsCredits: true, quote, balance: await getBalance(auth.orgId) }, { status: 402 });

  try {
    const created: { workspaceId: string; vertical: string; count: number }[] = [];
    for (const [vertical, list] of groups) {
      const keyword = vertical === "grocery" ? "Indian grocery" : vertical === "restaurant" ? "Indian restaurants" : vertical;
      const { workspaceId, count } = await createAreaWorkspace(auth.orgId, {
        area: label, keyword, vertical, center: null, businesses: list,
      });
      await enqueueWorkspaceCollection(workspaceId);
      created.push({ workspaceId, vertical, count });
    }
    void logEvent("monitor_selected", { label, batches: created.length, total: businesses.length, quote }, { orgId: auth.orgId, path: "/monitor/queue" });
    after(() => nudgeWorker());
    return NextResponse.json({ created, total: businesses.length, quote, balance: await getBalance(auth.orgId) });
  } catch (e) {
    // Nothing (or only part) created after charging → refund the whole batch.
    await refundCredits(auth.orgId, quote, "monitor_selected_refund", { label, error: (e as Error).message });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
