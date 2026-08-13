import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { requireOrg, workspaceInOrg } from "@/lib/api";

/**
 * POST /api/reports/recipients — save where this workspace's report is delivered:
 * goals.notifyEmail (override; else the owner's login email is used) and
 * goals.notifyWhatsApp (a number, required for the WhatsApp channel). Empty string
 * clears a field. Tenant-checked; service-role write to merge into goals.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const auth = await requireOrg();
  if (!auth || !(await workspaceInOrg(ws.id, auth.orgId))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { email?: string; whatsapp?: string };
  const email = typeof body.email === "string" ? body.email.trim() : undefined;
  const whatsapp = typeof body.whatsapp === "string" ? body.whatsapp.replace(/\D/g, "") : undefined;

  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "bad_email" }, { status: 400 });
  if (whatsapp && whatsapp.length < 8) return NextResponse.json({ error: "bad_number" }, { status: 400 });

  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const next = { ...((data?.goals as Record<string, any>) ?? {}) };
  if (email !== undefined) { if (email) next.notifyEmail = email; else delete next.notifyEmail; }
  if (whatsapp !== undefined) { if (whatsapp) next.notifyWhatsApp = whatsapp; else delete next.notifyWhatsApp; }
  await svc.from("workspace").update({ goals: next }).eq("id", ws.id);

  return NextResponse.json({ ok: true, email: next.notifyEmail ?? null, whatsapp: next.notifyWhatsApp ?? null });
}
