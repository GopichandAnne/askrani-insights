import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/api";
import { buildDigest } from "@/lib/digest";
import { buildReportInput, renderReportPdf } from "@/lib/reportpdf";
import { digestRecipient, sendDigest, emailConfigured } from "@/lib/notify";
import { whatsappConfigured, whatsAppRecipient, sendWhatsAppReport } from "@/lib/whatsapp";
import { spendCredits, refundCredits, REPORT_ON_DEMAND_CREDITS } from "@/lib/credits";

/**
 * POST /api/reports/send — email / WhatsApp the full report to the owner NOW,
 * off-cadence, on whichever channels are configured + have a recipient. Spends
 * REPORT_ON_DEMAND_CREDITS once (refunded if every channel fails). The pay-with-
 * credits path: grab today's report without waiting for the scheduled push.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, (_m, a, d) => `${a}•••${d}`);
const maskPhone = (p: string) => (p.length > 4 ? `•••${p.slice(-4)}` : p);

export async function POST() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "no_org" }, { status: 401 });

  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};

  // resolve which channels can actually deliver right now
  const emailTo = emailConfigured() ? await digestRecipient(svc, auth.orgId, goals) : null;
  const waTo = whatsappConfigured() ? whatsAppRecipient(goals) : null;
  if (!emailTo && !waTo) return NextResponse.json({ error: "no_channel" }, { status: 400 });

  // charge up-front, refund if nothing sends
  const charged = await spendCredits(auth.orgId, REPORT_ON_DEMAND_CREDITS, "report_on_demand", { workspaceId: ws.id });
  if (!charged) return NextResponse.json({ error: "insufficient_credits", need: REPORT_ON_DEMAND_CREDITS }, { status: 402 });

  const digest = buildDigest({ name: ws.name, vertical: ws.vertical }, goals, (goals.digestSeen?.ids as string[]) ?? []);
  const sent: string[] = [];
  try {
    const pdf = await renderReportPdf(buildReportInput({ name: ws.name }, goals, digest, "weekly"));
    if (emailTo && (await sendDigest(emailTo, ws.name, digest, pdf, "weekly"))) sent.push(`email ${maskEmail(emailTo)}`);
    if (waTo && (await sendWhatsAppReport(waTo, ws.name, digest, pdf))) sent.push(`WhatsApp ${maskPhone(waTo)}`);
  } catch { /* fall through to refund if nothing landed */ }

  if (!sent.length) {
    await refundCredits(auth.orgId, REPORT_ON_DEMAND_CREDITS, "report_on_demand_refund", { workspaceId: ws.id });
    return NextResponse.json({ error: "send_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, sent, charged: REPORT_ON_DEMAND_CREDITS });
}
