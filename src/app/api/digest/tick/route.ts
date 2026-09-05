import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { buildDigest, markDigestSeen } from "@/lib/digest";
import { buildAttention } from "@/lib/attention";
import { digestRecipient, sendDigest, emailConfigured } from "@/lib/notify";
import { whatsappConfigured, whatsAppRecipient, sendWhatsAppReport } from "@/lib/whatsapp";
import { buildReportInput, renderReportPdf } from "@/lib/reportpdf";
import { planOfOrg, cadenceForPlan } from "@/lib/credits";

/**
 * Digest push. The cron runs DAILY; for each workspace it fires only when due for
 * that org's PLAN CADENCE (daily on Growth/Pro, weekly on Free/Starter — see
 * cadenceForPlan) per goals.lastDigestAt. It builds the digest from the cached
 * pillars (no scrape, no cost), stores it on goals.digest for the in-app feed,
 * emails it (+ the full PDF report) to the owner if email is configured, and
 * stamps the seen set so the next digest only flags what's new.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const SLACK = 60 * 60 * 1000;

function authorized(req: Request): boolean {
  const worker = process.env.WORKER_SECRET;
  const cron = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const provided = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (worker && provided === worker) return true;
  if (cron && auth === `Bearer ${cron}`) return true;
  if (cron && req.headers.get("x-vercel-cron") === "1") return true;
  return false;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const force = new URL(req.url).searchParams.get("force") === "1";
  const onlyWs = new URL(req.url).searchParams.get("workspaceId") || undefined;

  const svc = createServiceClient();
  let q = svc.from("workspace").select("id, name, vertical, organization_id, goals, target_business_id");
  if (onlyWs) q = q.eq("id", onlyWs);
  const { data: wss } = await q;
  // Skip ephemeral deep-read workspaces — they're one-shot snapshots, not monitored.
  const workspaces = (wss ?? []).filter((w: any) => (w.target_business_id || w.goals?.subjectType === "area") && !w.goals?.ephemeral);

  const now = Date.now();
  let due = 0, built = 0, emailed = 0, whatsapped = 0, empty = 0;

  for (const w of workspaces as any[]) {
    const goals = (w.goals as Record<string, any>) ?? {};
    const last = goals.lastDigestAt ? Date.parse(goals.lastDigestAt) : 0;
    // cadence is a plan lever: Growth/Pro get a daily report, Free/Starter weekly
    const cadence = cadenceForPlan(w.organization_id ? await planOfOrg(w.organization_id) : "free");
    const interval = cadence === "daily" ? DAY : WEEK;
    if (!force && last && now - last < interval - SLACK) continue;
    due++;

    const digest = buildDigest({ name: w.name, vertical: w.vertical }, goals, (goals.digestSeen?.ids as string[]) ?? [], new Date(now));
    // Attention board — the ranked 2-4 that NEED attention + the steady count, competitor
    // & pricing first. Deterministic, built from the same cached pillars as the digest.
    const attention = buildAttention({ name: w.name, vertical: w.vertical }, goals, (goals.attentionSeen?.ids as string[]) ?? [], new Date(now));
    const stampedAt = new Date(now).toISOString();

    // store the digest + attention board for the in-app surfaces + stamp cadence/seen
    await svc.from("workspace").update({ goals: { ...goals, digest, attention, lastDigestAt: stampedAt, attentionSeen: { ids: attention.items.map((i) => i.id), at: stampedAt } } }).eq("id", w.id);

    if (!digest.items.length) { empty++; continue; }
    built++;

    // render the report PDF once, share it across every configured channel
    let pdf: Buffer | undefined;
    try { pdf = await renderReportPdf(buildReportInput({ name: w.name }, goals, digest, cadence)); }
    catch { pdf = undefined; } // never let a render hiccup block delivery

    // push via email (+ PDF attached) if configured + a recipient resolves
    if (emailConfigured()) {
      const to = await digestRecipient(svc, w.organization_id, goals);
      if (to && (await sendDigest(to, w.name, digest, pdf, cadence))) emailed++;
    }

    // push via WhatsApp (the PDF as a document) if configured + a number is on file
    if (whatsappConfigured() && pdf) {
      const wa = whatsAppRecipient(goals);
      if (wa && (await sendWhatsAppReport(wa, w.name, digest, pdf))) whatsapped++;
    }

    await markDigestSeen(w.id, digest.items.map((i) => i.id), new Date(now));
  }

  return NextResponse.json({ checked: workspaces.length, due, built, emailed, whatsapped, empty, emailConfigured: emailConfigured(), whatsappConfigured: whatsappConfigured() });
}

export const POST = GET;
