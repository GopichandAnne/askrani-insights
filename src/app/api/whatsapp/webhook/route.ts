import { after } from "next/server";
import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { sendWhatsAppText, whatsappConfigured, downloadWhatsAppMedia } from "@/lib/whatsapp";
import { transcribeAudio } from "@/lib/transcribe";
import { answerFromData, routeToBusiness } from "@/lib/assistant";
import { applyAssistantAction } from "@/lib/assistantActions";
import { readConversation, appendConversation, recentTurns, resolveWaParticipant } from "@/lib/conversation";
import { readWaSession, writeWaSession, type WaSession } from "@/lib/wasession";

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

interface Inbound { from: string; text?: string; audioId?: string }

type Ws = { id: string; name: string; vertical?: string; organization_id: string; target_business_id?: string | null; goals?: Record<string, any> };

/** All workspaces that saved this number. Exact digits first; then a suffix match
 *  on the last 9 digits, so a number saved without the country code / with other
 *  formatting still links. Constrained to one org (a number belongs to one owner). */
async function candidatesFor(svc: ReturnType<typeof createServiceClient>, from: string): Promise<Ws[]> {
  const cols = "id, name, vertical, organization_id, target_business_id, goals";
  let rows = (await svc.from("workspace").select(cols).eq("goals->>notifyWhatsApp", from).limit(10)).data ?? [];
  if (!rows.length) {
    const tail = from.slice(-9);
    if (tail.length >= 9) rows = (await svc.from("workspace").select(cols).ilike("goals->>notifyWhatsApp", `%${tail}`).limit(10)).data ?? [];
  }
  const list = rows as Ws[];
  if (list.length <= 1) return list;
  const org = list[0].organization_id; // keep a single owner's businesses
  return list.filter((w) => w.organization_id === org);
}

const isSelectionLike = (t: string) => { const w = t.trim().split(/\s+/); return /^#?\d{1,2}$/.test(t.trim()) || w.length <= 3; };

async function handle(m: Inbound) {
  if (!whatsappConfigured()) return;

  // Resolve the message text — transcribe a voice note if that's what they sent,
  // so a spoken question is answered exactly like a typed one.
  let text = (m.text ?? "").trim();
  let transcribed = false;
  if (!text && m.audioId) {
    const media = await downloadWhatsAppMedia(m.audioId);
    const heard = media ? await transcribeAudio(media.bytes, "note.ogg", media.mime) : null;
    if (!heard) {
      await sendWhatsAppText(m.from, "I couldn't quite catch that voice note — mind typing it, or sending it again?");
      return;
    }
    text = heard;
    transcribed = true;
  }
  if (!text) return;

  const svc = createServiceClient();
  const candidates = await candidatesFor(svc, m.from);
  if (!candidates.length) {
    await sendWhatsAppText(m.from, "Hi! This number isn't linked to a business on Ask Rani Insights yet. Add it under Reports → “Where your report is delivered”, then message me to ask about your market.");
    return;
  }
  const orgId = candidates[0].organization_id;
  const session: WaSession = (await readWaSession(svc, orgId, m.from)) ?? { history: [], at: new Date().toISOString() };

  // ── choose the active business ────────────────────────────────────────────
  let active: Ws | undefined;
  let question = text;

  if (candidates.length === 1) {
    active = candidates[0];
  } else {
    // route the message to a business (handles "1", a name, "how's my deli?", switches)
    const idx = await routeToBusiness(candidates.map((c) => ({ id: c.id, name: c.name, vertical: c.vertical })), text);
    if (idx != null) {
      active = candidates[idx];
      // if this was the reply to a "which business?" prompt, answer their ORIGINAL question
      if (session.pending?.question && isSelectionLike(text)) question = session.pending.question;
    } else {
      active = candidates.find((c) => c.id === session.workspaceId); // generic follow-up → stay on the active one
    }
    if (!active) {
      // still ambiguous → ask, remembering what they wanted
      const list = candidates.map((c, i) => `${i + 1}) ${c.name}`).join("\n");
      session.pending = { candidateIds: candidates.map((c) => c.id), question: text };
      await writeWaSession(svc, orgId, m.from, session);
      await sendWhatsAppText(m.from, `You watch a few businesses — which one is this about? Reply with a number:\n${list}`);
      return;
    }
  }

  // ── answer, grounded, with recent context ─────────────────────────────────
  const switched = candidates.length > 1 && session.workspaceId && session.workspaceId !== active.id;
  // Context from THIS PERSON's persistent thread. We resolve the sender's number to
  // their auth account so their WhatsApp thread is the SAME thread as their web chat
  // (cross-channel, per person); an unknown number gets a stable per-number thread.
  const pid = await resolveWaParticipant(svc, orgId, m.from);
  const convo = await readConversation(svc, active.id, pid);
  const { answer, action } = await answerFromData(
    { id: active.id, name: active.name, vertical: active.vertical, target_business_id: active.target_business_id },
    (active.goals as Record<string, any>) ?? {}, question, recentTurns(convo, 10), svc,
  );

  // If the copilot decided on a config change (notify address, link a Rani store,
  // remove a competitor), execute it against THIS workspace — same as the web chat.
  // On failure, replace the confirming answer with the reason so we never falsely
  // tell the owner it's done.
  let finalAnswer = answer;
  if (action) {
    const res = await applyAssistantAction(svc, { id: active.id }, action);
    if (!res.ok) finalAnswer = res.note ? `I couldn't do that — ${res.note}` : "I couldn't make that change — please try again.";
  }

  // Echo back a voice note's transcript so a mis-hear is obvious to the owner.
  const echo = transcribed ? `🎙️ “${text}”\n\n` : "";
  const reply = echo + (candidates.length > 1 ? `${switched ? `Now on ${active.name}.\n` : `(${active.name}) `}${finalAnswer}` : finalAnswer);

  session.workspaceId = active.id;
  session.pending = undefined;
  session.history = [...session.history, { role: "user", text: question }, { role: "assistant", text: finalAnswer }];
  await writeWaSession(svc, orgId, m.from, session);
  await appendConversation(svc, active.id, pid, [{ role: "user", text: question }, { role: "assistant", text: finalAnswer }]);
  await sendWhatsAppText(m.from, reply);
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
        } else if (msg?.type === "audio" && msg?.audio?.id && msg?.from) {
          // Voice notes arrive as type "audio" (voice:true) — transcribe in handle().
          inbound.push({ from: String(msg.from).replace(/\D/g, ""), audioId: String(msg.audio.id) });
        }
      }
    }
  }

  // ack immediately; answer + reply after the response so Meta doesn't retry
  if (inbound.length) after(async () => { for (const m of inbound) { try { await handle(m); } catch { /* keep going */ } } });

  return new Response("ok", { status: 200 });
}
