import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { getUser } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyContentRequest } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * "Have our team make this" — captures a content-creation request when Rani suggests
 * a visual (reel/poster/post) the owner would need help producing. Remote-edit-first:
 * they share a photo/clip and our team finishes it, or they request an on-site shoot.
 * Logged on goals.contentRequests (in-app record) + emailed to the team (demand
 * queue). This is a lead capture + demand probe — no media handling here.
 */
export async function POST(req: Request) {
  const state = await activeWorkspace();
  const user = await getUser();
  if (state.status !== "ok" || !user) return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const body = (await req.json().catch(() => ({}))) as { idea?: string; context?: string; capture?: string; kind?: string; note?: string };
  const idea = String(body.idea ?? "").slice(0, 400).trim();
  if (!idea) return NextResponse.json({ error: "no_idea" }, { status: 400 });
  const capture: "share" | "shoot" = body.capture === "shoot" ? "shoot" : "share";
  const kind = String(body.kind ?? "photo").slice(0, 20);
  const note = String(body.note ?? "").slice(0, 500).trim();

  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const entry = { idea, context: String(body.context ?? "").slice(0, 200), capture, kind, note, contact: user.email ?? null, at: new Date().toISOString(), by: user.id };
  const contentRequests = [entry, ...((goals.contentRequests as any[]) ?? [])].slice(0, 50);
  await svc.from("workspace").update({ goals: { ...goals, contentRequests } }).eq("id", ws.id).then(() => {}, () => {});

  // best-effort team notification (env-gated); the in-app record above is the source of truth
  await notifyContentRequest(ws.name, idea, capture, kind, note, user.email ?? null);

  return NextResponse.json({ ok: true });
}
