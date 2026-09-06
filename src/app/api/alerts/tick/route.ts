import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { decideAlerts, alertBoard, seedAlertBaseline, markAlerted } from "@/lib/alerts";
import { sendAlertEmail, digestRecipient, orgOwnerEmail, emailConfigured } from "@/lib/notify";
import { mintBriefLink, isBriefLinkConfigured } from "@/lib/brieflink";
import { anchorFor } from "@/lib/anchor";
import { whatsappConfigured, whatsAppRecipient, sendWhatsAppBrief } from "@/lib/whatsapp";

/**
 * Real-time trigger alerts. This cron runs FREQUENTLY (every ~30 min) but pushes
 * NOTHING unless a genuinely new, high-impact signal has appeared since the last
 * alert (see lib/alerts.ts — separate seen-set + cooldown + per-day cap + min gap
 * + first-run baseline). It builds the decision from the cached attention board
 * (deterministic, no scrape, no LLM, no cost), so a tick with nothing to say is
 * effectively free. When something fires, it deep-links the owner straight into
 * /brief on the item, via email (urgent framing) and WhatsApp (the market_brief
 * template). Distinct from /api/digest/tick, which is the scheduled weekly brief.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  const url = new URL(req.url);
  const onlyWs = url.searchParams.get("workspaceId") || undefined;
  const dryRun = url.searchParams.get("dryRun") === "1"; // decide + report, don't send/stamp

  const svc = createServiceClient();
  let q = svc.from("workspace").select("id, name, vertical, organization_id, goals, target_business_id");
  if (onlyWs) q = q.eq("id", onlyWs);
  const { data: wss } = await q;
  // Monitored workspaces only — same filter as the digest (skip one-shot deep-reads).
  const workspaces = (wss ?? []).filter((w: any) => (w.target_business_id || w.goals?.subjectType === "area") && !w.goals?.ephemeral);

  const now = new Date();
  const origin = process.env.NEXT_PUBLIC_APP_URL || "https://insights.askrani.ai";
  let checked = 0, seeded = 0, fired = 0, emailed = 0, whatsapped = 0;
  const details: any[] = [];

  for (const w of workspaces as any[]) {
    checked++;
    const goals = (w.goals as Record<string, any>) ?? {};
    const decision = decideAlerts({ name: w.name, vertical: w.vertical }, goals, now);

    // First-ever run for this workspace → establish the baseline silently.
    if (decision.baseline) {
      if (!dryRun) await seedAlertBaseline(w.id, decision.baseline, now);
      seeded++;
      if (dryRun) details.push({ ws: w.name, action: "seed baseline", ids: decision.baseline });
      continue;
    }

    if (!decision.alerts.length) {
      if (dryRun) details.push({ ws: w.name, skipped: decision.skipped });
      continue;
    }

    if (dryRun) { details.push({ ws: w.name, wouldAlert: decision.alerts.map((a) => a.headline) }); fired++; continue; }

    // Deep-links: board + per-item, minted when the secret is set and we can resolve
    // the owner's AUTH email (mirrors the digest tick). Falls back to plain links.
    let boardUrl: string | undefined;
    const byId: Record<string, string> = {};
    if (isBriefLinkConfigured()) {
      const tokenEmail = await orgOwnerEmail(svc, w.organization_id);
      if (tokenEmail) {
        boardUrl = mintBriefLink(origin, tokenEmail, w.id, "/brief") ?? undefined;
        for (const it of decision.alerts) {
          const u = mintBriefLink(origin, tokenEmail, w.id, `/brief#${anchorFor(it.id)}`);
          if (u) byId[it.id] = u;
        }
      }
    }

    const channels: string[] = [];
    if (emailConfigured()) {
      const to = await digestRecipient(svc, w.organization_id, goals);
      if (to && (await sendAlertEmail(to, w.name, decision.alerts, { board: boardUrl, byId }))) { emailed++; channels.push("email"); }
    }
    if (whatsappConfigured()) {
      const wa = whatsAppRecipient(goals);
      // WhatsApp proactive send needs a deep-link token (the template's URL button).
      if (wa && boardUrl && (await sendWhatsAppBrief(wa, w.name, alertBoard(decision.board, decision.alerts), boardUrl))) { whatsapped++; channels.push("whatsapp"); }
    }

    // Stamp cooldown + min-gap + log even if no channel was configured, so we don't
    // re-evaluate the same signal endlessly; it just means "decided to alert".
    await markAlerted(w.id, decision.alerts, channels, now);
    fired++;
  }

  return NextResponse.json({
    checked, seeded, fired, emailed, whatsapped,
    emailConfigured: emailConfigured(), whatsappConfigured: whatsappConfigured(),
    ...(dryRun ? { dryRun: true, details } : {}),
  });
}

export const POST = GET;
