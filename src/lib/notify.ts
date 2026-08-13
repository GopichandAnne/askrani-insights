import type { SupabaseClient } from "@supabase/supabase-js";
import type { Digest, DigestItem } from "@/lib/digest";

/**
 * Delivery for the weekly digest. Email is the pragmatic push channel for a busy
 * SMB owner. It's ENV-GATED (RESEND_API_KEY) and uses Resend's REST API directly
 * — no dependency to add — so the moment the key is set in the environment, the
 * digest starts landing in the owner's inbox; until then the digest still lives
 * in-app and this is a graceful no-op. Same self-serve pattern as the Apify
 * features. The recipient is the workspace's own notify address if set, else the
 * org owner's login email.
 */

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

const FROM = () => process.env.DIGEST_FROM || "Ask Rani Insights <insights@askrani.ai>";
const APP_URL = () => (process.env.NEXT_PUBLIC_APP_URL || "https://insights.askrani.ai").replace(/\/$/, "");

/** Best-effort recipient: goals.notifyEmail → org owner's auth email. */
export async function digestRecipient(
  svc: SupabaseClient,
  orgId: string | null | undefined,
  goals: Record<string, any>,
): Promise<string | null> {
  const pinned = typeof goals?.notifyEmail === "string" ? goals.notifyEmail.trim() : "";
  if (pinned) return pinned;
  if (!orgId) return null;
  const { data: mem } = await svc
    .from("org_membership")
    .select("user_id, role")
    .eq("organization_id", orgId)
    .order("role", { ascending: true }) // "owner" sorts before others alphabetically enough; we also fall back
    .limit(5);
  const ownerFirst = [...(mem ?? [])].sort((a: any, b: any) => (a.role === "owner" ? -1 : 0) - (b.role === "owner" ? -1 : 0));
  for (const m of ownerFirst) {
    try {
      const { data } = await (svc as any).auth.admin.getUserById(m.user_id);
      const email = data?.user?.email;
      if (email) return email as string;
    } catch { /* keep trying */ }
  }
  return null;
}

interface EmailAttachment { filename: string; content: string } // content = base64

async function sendEmail(to: string, subject: string, html: string, attachments?: EmailAttachment[]): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const body: Record<string, unknown> = { from: FROM(), to, subject, html };
    if (attachments?.length) body.attachments = attachments;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const SEV_COLOR: Record<DigestItem["severity"], string> = { alert: "#c2410c", opportunity: "#0f766e", fyi: "#6b7280" };

function itemRow(it: DigestItem): string {
  const actLine = it.act
    ? `<div style="margin-top:6px"><a href="${APP_URL()}/?act=${encodeURIComponent(it.id)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:7px 14px;border-radius:999px">Act on it →</a></div>`
    : "";
  return `
  <tr><td style="padding:14px 0;border-top:1px solid #eee">
    <div style="font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:${SEV_COLOR[it.severity]}">${it.icon} ${escapeHtml(it.pillar)}${it.isNew ? ' · <span style="color:#b45309">new</span>' : ""}</div>
    <div style="font-size:16px;font-weight:700;color:#111827;margin-top:2px">${escapeHtml(it.title)}</div>
    <div style="font-size:14px;color:#4b5563;margin-top:2px;line-height:1.45">${escapeHtml(it.detail)}</div>
    ${actLine}
  </td></tr>`;
}

export function renderDigestEmail(business: string, digest: Digest, opts?: { hasPdf?: boolean }): { subject: string; html: string } {
  const subject = digest.alertCount > 0
    ? `${business}: ${digest.headline}`
    : `${business} — your weekly market digest`;
  const rows = digest.items.map(itemRow).join("");
  const pdfNote = opts?.hasPdf
    ? `<div style="font-size:13px;color:#0f766e;background:#ecfdf5;border-radius:10px;padding:11px 14px;margin-top:16px">📄 <b>Your full market report is attached as a PDF</b> — sales, marketing moves, what's popular and what's changing in your market.</div>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:24px 20px">
      <div style="font-size:13px;font-weight:700;color:#0d9488;letter-spacing:.04em">ASK RANI INSIGHTS</div>
      <h1 style="font-size:22px;color:#111827;margin:6px 0 2px">${escapeHtml(business)}</h1>
      <div style="font-size:15px;color:#374151">${escapeHtml(digest.headline)}</div>
      <table role="presentation" width="100%" style="border-collapse:collapse;margin-top:10px">${rows}</table>
      ${pdfNote}
      <div style="margin-top:22px"><a href="${APP_URL()}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 20px;border-radius:999px">Open your dashboard</a></div>
      <div style="font-size:12px;color:#9ca3af;margin-top:20px">You're getting this because you watch ${escapeHtml(business)} on Ask Rani Insights.</div>
    </div>
  </body></html>`;
  return { subject, html };
}

export async function sendDigest(to: string, business: string, digest: Digest, pdf?: Buffer): Promise<boolean> {
  const { subject, html } = renderDigestEmail(business, digest, { hasPdf: !!pdf });
  const safe = business.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const attachments = pdf ? [{ filename: `askrani-${safe}-weekly-report.pdf`, content: pdf.toString("base64") }] : undefined;
  return sendEmail(to, subject, html, attachments);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
