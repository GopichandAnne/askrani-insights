import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Server-side speech-to-text (OpenAI Whisper). The copilot mic tries the browser's
 * on-device Web Speech API first (Chrome/Edge/Android only); everywhere else — iOS
 * Safari, in-app WebViews — the client records with MediaRecorder and POSTs the
 * audio here so voice works on every device. Signed-in only (guards the STT key).
 */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: "voice transcription isn't configured" }, { status: 503 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch { /* bad body */ }
  if (!file || file.size === 0) return NextResponse.json({ error: "no audio" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "audio too long" }, { status: 413 });

  const out = new FormData();
  out.append("file", file, file.name || "speech.webm");
  out.append("model", "whisper-1");
  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: out,
    });
    if (!r.ok) return NextResponse.json({ error: "couldn't transcribe" }, { status: 502 });
    const d = await r.json();
    return NextResponse.json({ text: String(d.text ?? "").trim() });
  } catch {
    return NextResponse.json({ error: "couldn't transcribe" }, { status: 502 });
  }
}
