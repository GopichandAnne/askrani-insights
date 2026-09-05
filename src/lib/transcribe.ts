/**
 * Server-side speech-to-text, reusable + auth-free so both the copilot mic route
 * and the WhatsApp webhook can call it. Insights has no OpenAI key by default, so
 * it BORROWS Rani's Whisper via the shared transcribe edge function (RANI_OPS_SECRET
 * — same governed-contract pattern as the wallet/ops-slice); if a local
 * OPENAI_API_KEY is set, it uses that directly. Returns null when unconfigured or
 * on any failure, so callers degrade gracefully.
 */
export function transcribeConfigured(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.RANI_OPS_SECRET);
}

export async function transcribeAudio(bytes: Uint8Array, filename = "speech.ogg", mime = "audio/ogg"): Promise<string | null> {
  const localKey = process.env.OPENAI_API_KEY;
  const raniUrl = (process.env.RANI_TRANSCRIBE_URL || "https://api.askrani.ai/functions/v1/transcribe").replace(/\/$/, "");
  const raniSecret = process.env.RANI_OPS_SECRET;

  const out = new FormData();
  // `as BlobPart` sidesteps a TS lib quirk (Uint8Array's ArrayBufferLike vs the
  // stricter ArrayBuffer expected by BlobPart); the bytes are a real audio buffer.
  out.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);

  try {
    if (localKey) {
      out.append("model", "whisper-1");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${localKey}` }, body: out,
      });
      if (!r.ok) return null;
      return String((await r.json()).text ?? "").trim() || null;
    }
    if (raniSecret) {
      const r = await fetch(raniUrl, { method: "POST", headers: { "x-ops-secret": raniSecret }, body: out });
      if (!r.ok) return null;
      return String((await r.json()).text ?? "").trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}
