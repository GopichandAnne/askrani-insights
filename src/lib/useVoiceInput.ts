"use client";

import { useRef, useState } from "react";

type SpeechRec = {
  lang: string; interimResults: boolean;
  onresult: (e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) => void;
  onerror: () => void; onend: () => void; start: () => void; stop: () => void;
};
type SpeechWindow = Window & { webkitSpeechRecognition?: new () => SpeechRec; SpeechRecognition?: new () => SpeechRec };

/**
 * Mic input with a graceful fallback so voice works on EVERY device:
 *   • Chrome/Edge/Android → the browser's on-device Web Speech API (instant, free).
 *   • Everywhere else (iOS Safari, WhatsApp in-app browser, WebViews) → record with
 *     MediaRecorder and transcribe on the server via `transcribe` (Whisper).
 * `toggle()` starts/stops; `listening` = capturing, `busy` = transcribing.
 */
export function useVoiceInput(transcribe: (blob: Blob) => Promise<string>, onText: (t: string) => void) {
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const speechRef = useRef<SpeechRec | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  function extFor(type: string) {
    if (type.includes("mp4") || type.includes("m4a")) return "mp4";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("wav")) return "wav";
    return "webm";
  }

  async function start() {
    const w = (typeof window !== "undefined" ? window : undefined) as SpeechWindow | undefined;
    const SR = w?.webkitSpeechRecognition || w?.SpeechRecognition;
    if (SR) {
      const rec = new SR();
      speechRef.current = rec;
      rec.lang = navigator.language || "en-US";
      rec.interimResults = false;
      rec.onresult = (e) => onText(e.results[0]?.[0]?.transcript ?? "");
      rec.onerror = () => setListening(false);
      rec.onend = () => { setListening(false); speechRef.current = null; };
      setListening(true);
      rec.start();
      return;
    }
    // MediaRecorder → server (Whisper) fallback
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recRef.current = null;
        const type = mr.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (!blob.size) return;
        setBusy(true);
        try {
          const named = new File([blob], `speech.${extFor(type)}`, { type });
          const text = await transcribe(named);
          if (text) onText(text);
        } catch { /* ignore */ } finally { setBusy(false); }
      };
      setListening(true);
      mr.start();
    } catch {
      setListening(false);
    }
  }

  function stop() {
    if (speechRef.current) { try { speechRef.current.stop(); } catch { /* */ } speechRef.current = null; setListening(false); return; }
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    setListening(false);
  }

  const toggle = () => (listening ? stop() : start());
  return { listening, busy, toggle };
}
