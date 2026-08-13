import { after } from "next/server";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { sendWhatsAppText, whatsappConfigured } from "@/lib/whatsapp";
import { answerFromData } from "@/lib/assistant";

/**
 * Inbound WhatsApp — the two-way assistant. Meta calls this webhook when the owner
 * messages our number; we resolve their workspace by the sender number
 * (goals.notifyWhatsApp), answer their question GROUNDED strictly in their
 * collected data (see assistant.ts — no hallucination), and reply as free-form
 * text (allowed inside the 24h window their message opens). We ack fast and do the
 * LLM work in `after()` so Meta never times out and re-delivers.
 *
 * Setup: point the WhatsApp app's webhook at /api/whatsapp/webhook with
 * WHATSAPP_VERIFY_TOKEN; set WHATSAPP_APP_SECRET to verify payload signatures.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// GET — Meta webhook verification handshake.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const mode = u.searchParams.get("hub.mode");
  const token = u.searchParams.get("hub.verify_token");
  const challenge = u.searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

function validSignature(raw: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // not enforced unless the app secret is configured
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected)); } catch { return false; }
}

interface Inbound { from: string; text: string }

async function handle(m: Inbound) {
  if (!whatsappConfigured()) return;
  const svc = createServiceClient();
  // link the sender to a workspace by the number they saved for delivery
  const { data } = await svc
    .from("workspace")
    .select("id, name, vertical, goals")
    .eq("goals->>notifyWhatsApp", m.from)
    .limit(1);
  const ws = data?.[0] as { name: string; vertical?: string; goals?: Record<string, any> } | undefined;
  if (!ws) {
    await sendWhatsAppText(m.from, "Hi! This number isn't linked to a business on Ask Rani Insights yet. Add it under Reports → “Where your report is delivered”, then message me to ask about your market.");
    return;
  }
  const { answer } = await answerFromData({ name: ws.name, vertical: ws.vertical }, (ws.goals as Record<string, any>) ?? {}, m.text);
  await sendWhatsAppText(m.from, answer);
}

// POST — inbound messages (and status callbacks, which we ignore).
export async function POST(req: Request) {
  const raw = await req.text();
  if (!validSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("bad signature", { status: 401 });
  }

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("ok"); }

  const inbound: Inbound[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        if (msg?.type === "text" && msg?.text?.body && msg?.from) {
          inbound.push({ from: String(msg.from).replace(/\D/g, ""), text: String(msg.text.body) });
        }
      }
    }
  }

  // ack immediately; answer + reply after the response so Meta doesn't retry
  if (inbound.length) after(async () => { for (const m of inbound) { try { await handle(m); } catch { /* keep going */ } } });

  return new Response("ok", { status: 200 });
}
