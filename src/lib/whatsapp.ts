import type { Digest } from "@/lib/digest";
import type { AttentionBoard } from "@/lib/attention";

/**
 * WhatsApp delivery via the WhatsApp Business Cloud API (Meta Graph). ENV-GATED —
 * set WHATSAPP_TOKEN + WHATSAPP_PHONE_ID (+ an approved WHATSAPP_TEMPLATE) and
 * report pushes start landing on WhatsApp as a PDF document; until then it's a
 * graceful no-op, the same self-serve pattern as the Resend email channel.
 *
 * A business-initiated push must use a pre-approved TEMPLATE. The expected shape
 * (name via WHATSAPP_TEMPLATE, e.g. "market_report", language via WHATSAPP_LANG):
 *   HEADER: Document
 *   BODY:   "Hi {{1}}, your latest market report is ready — {{2}}"   ({{1}}=business, {{2}}=headline)
 * The PDF is uploaded to the Cloud API media endpoint first (no public hosting, so
 * the report is never exposed at a URL), then referenced by its media id.
 */

const GRAPH = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v21.0"}`;

export function whatsappConfigured(): boolean {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

/** The human-readable business number owners message to chat (display + wa.me link).
 *  PHONE_ID is Meta's internal id, not dialable — this is the actual number. */
export function whatsappBusinessNumber(): string | null {
  const n = (process.env.WHATSAPP_BUSINESS_NUMBER || "").trim();
  return n || null;
}

/** Recipient WhatsApp number (digits, international format) from goals.notifyWhatsApp. */
export function whatsAppRecipient(goals: Record<string, any>): string | null {
  const raw = typeof goals?.notifyWhatsApp === "string" ? goals.notifyWhatsApp : "";
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/** Send a plain-text WhatsApp reply. Allowed free-form within the 24h window the
 *  owner opens by messaging us — so no template needed for Q&A answers. */
export async function sendWhatsAppText(to: string, body: string): Promise<boolean> {
  if (!whatsappConfigured()) return false;
  try {
    const r = await fetch(`${GRAPH()}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4000), preview_url: false } }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Upload the PDF to the Cloud API media endpoint → media id (kept private, not a URL). */
async function uploadMedia(pdf: Buffer, filename: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    const r = await fetch(`${GRAPH()}/${process.env.WHATSAPP_PHONE_ID}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: form,
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({} as any));
    return typeof d.id === "string" ? d.id : null;
  } catch {
    return null;
  }
}

/**
 * Send the BRIEF to WhatsApp — the 2-4 that need attention, with a button that
 * opens straight into /brief already signed in (the deep-link). Business-initiated,
 * so it needs a pre-approved UTILITY template with a dynamic URL button.
 *
 * Register this template (name via WHATSAPP_BRIEF_TEMPLATE, default "market_brief";
 * language via WHATSAPP_LANG):
 *   CATEGORY: Utility
 *   BODY:   "Hi {{1}} 👋 Here's what's moving in your market: {{2}}"
 *           ({{1}} = business, {{2}} = a one-line summary)
 *   BUTTON: URL, "Open my brief", url: https://insights.askrani.ai/l?token={{1}}
 *           (dynamic — WhatsApp appends the token we pass to that base)
 *
 * `deepLinkUrl` is the full …/l?token=<token> URL; we pass only <token> as the
 * button variable. Requires the deep-link secret (no deep-link → caller sends the
 * PDF report instead), so a "Open my brief" button is never dead.
 */
export async function sendWhatsAppBrief(to: string, business: string, board: AttentionBoard, deepLinkUrl: string): Promise<boolean> {
  if (!whatsappConfigured()) return false;
  const token = (deepLinkUrl.split("token=")[1] ?? "").split("&")[0];
  if (!token) return false;
  const template = process.env.WHATSAPP_BRIEF_TEMPLATE || "market_brief";
  const lang = process.env.WHATSAPP_LANG || "en_US";

  const top = board.items.slice(0, 3).map((i) => i.headline).join("; ");
  const summary = (board.headline + (top ? ` — ${top}` : "")).replace(/\s+/g, " ").trim().slice(0, 640);

  try {
    const r = await fetch(`${GRAPH()}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code: lang },
          components: [
            { type: "body", parameters: [
              { type: "text", text: business.slice(0, 60) },
              { type: "text", text: summary },
            ] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: token }] },
          ],
        },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Send the report PDF to WhatsApp as a template message with a document header. */
export async function sendWhatsAppReport(to: string, business: string, digest: Digest, pdf: Buffer): Promise<boolean> {
  if (!whatsappConfigured()) return false;
  const template = process.env.WHATSAPP_TEMPLATE || "market_report";
  const lang = process.env.WHATSAPP_LANG || "en_US";
  const filename = `askrani-${business.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-report.pdf`;

  const mediaId = await uploadMedia(pdf, filename);
  if (!mediaId) return false;

  try {
    const r = await fetch(`${GRAPH()}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code: lang },
          components: [
            { type: "header", parameters: [{ type: "document", document: { id: mediaId, filename } }] },
            { type: "body", parameters: [
              { type: "text", text: business.slice(0, 60) },
              { type: "text", text: (digest.headline || "Your latest market update").slice(0, 120) },
            ] },
          ],
        },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
