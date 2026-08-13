import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { runFlyerBatch } from "@/lib/flyers";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Process the next batch of a workspace's flyer job. The client calls this
 * repeatedly after /api/flyers/run until { status: "done" }. Each call handles a
 * couple of profiles within a wall-clock budget, so every request is short.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 200;

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body.workspaceId ?? "").trim();
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("*").eq("id", workspaceId).maybeSingle();
  if (!ws || ws.organization_id !== auth.orgId) return NextResponse.json({ error: "workspace not found" }, { status: 404 });

  try {
    const result = await runFlyerBatch(ws as WorkspaceRow, { batchSize: 2, timeBudgetMs: 155000 });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
