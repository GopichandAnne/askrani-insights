import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/api";
import { buildDigest } from "@/lib/digest";
import { buildReportInput, renderReportPdf } from "@/lib/reportpdf";
import { digestRecipient, sendDigest, emailConfigured } from "@/lib/notify";
import { spendCredits, refundCredits, REPORT_ON_DEMAND_CREDITS } from "@/lib/credits";

/**
 * POST /api/reports/send — email the full report to the owner NOW, off-cadence.
 * Spends REPORT_ON_DEMAND_CREDITS (refunded if the send fails). This is the
 * pay-with-credits path the user asked for: a weekly-plan owner grabs today's
 * report without waiting for the scheduled push.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const mask = (e: string) => e.replace(/^(.).*(@.*)$/, (_m, a, d) => `${a}•••${d}`);

export async function POST() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "no_org" }, { status: 401 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_not_configured" }, { status: 400 });

  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const to = await digestRecipient(svc, auth.orgId, goals);
  if (!to) return NextResponse.json({ error: "no_recipient" }, { status: 400 });

  // charge up-front, refund on failure
  const charged = await spendCredits(auth.orgId, REPORT_ON_DEMAND_CREDITS, "report_on_demand", { workspaceId: ws.id });
  if (!charged) return NextResponse.json({ error: "insufficient_credits", need: REPORT_ON_DEMAND_CREDITS }, { status: 402 });

  const digest = buildDigest({ name: ws.name, vertical: ws.vertical }, goals, (goals.digestSeen?.ids as string[]) ?? []);
  let sent = false;
  try {
    const pdf = await renderReportPdf(buildReportInput({ name: ws.name }, goals, digest, "weekly"));
    sent = await sendDigest(to, ws.name, digest, pdf, "weekly");
  } catch { sent = false; }

  if (!sent) {
    await refundCredits(auth.orgId, REPORT_ON_DEMAND_CREDITS, "report_on_demand_refund", { workspaceId: ws.id });
    return NextResponse.json({ error: "send_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, to: mask(to), charged: REPORT_ON_DEMAND_CREDITS });
}
