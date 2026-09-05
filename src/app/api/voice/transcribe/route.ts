import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { transcribeAudio, transcribeConfigured } from "@/lib/transcribe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Server-side speech-to-text for the copilot mic (fallback when the browser's
 * on-device Web Speech API isn't available — iOS Safari, in-app WebViews, …).
 *
 * Insights has no OpenAI key (its advisor runs on Anthropic), so by default this
 * BORROWS Rani's Whisper via the shared `transcribe` edge function (RANI_OPS_SECRET
 * — same governed-contract pattern as the wallet/ops-slice). If a local
 * OPENAI_API_KEY is ever set, it uses that directly instead. Signed-in only.
 */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch { /* bad body */ }
  if (!file || file.size === 0) return NextResponse.json({ error: "no audio" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "audio too long" }, { status: 413 });

  if (!transcribeConfigured()) return NextResponse.json({ error: "voice transcription isn't configured" }, { status: 503 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = await transcribeAudio(bytes, file.name || "speech.webm", file.type || "audio/webm");
  if (text == null) return NextResponse.json({ error: "couldn't transcribe" }, { status: 502 });
  return NextResponse.json({ text });
}
