"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceInput } from "@/lib/useVoiceInput";

/**
 * In-app chat with Rani — the same advisor brain as WhatsApp, in a multi-turn
 * conversation. Client keeps the thread and sends recent history so follow-ups stay
 * in context; answers are grounded in the workspace's data + live rows + upcoming
 * occasions, and can be full "what should I run?" moves.
 */

interface Source { label: string; business?: string; platform?: string; url?: string }
interface Msg { role: "user" | "assistant"; text: string; grounded?: boolean; sources?: Source[] }

const SOURCE_EMOJI: Record<string, string> = {
  price: "💲", change: "📈", website: "🌐", google: "🔵", instagram: "📸", facebook: "👍", tiktok: "🎵", youtube: "▶️", doordash: "🛵", ubereats: "🛵",
};

const STARTERS = [
  "What should I run this month?",
  "How do my prices compare to rivals?",
  "How's my rating vs the market?",
  "What are competitors promoting right now?",
];

export function AssistantChat({ businessName }: { businessName: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const history = msgs.map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: q, history }),
      });
      const d = await r.json().catch(() => ({}));
      const answer = r.ok && typeof d.answer === "string" ? d.answer : "I couldn't reach the assistant just now — please try again.";
      setMsgs((m) => [...m, { role: "assistant", text: answer, grounded: !!d.grounded, sources: Array.isArray(d.sources) ? d.sources : [] }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", text: "I couldn't reach the assistant just now — please try again." }]);
    } finally {
      setBusy(false);
      setTimeout(() => taRef.current?.focus(), 20);
    }
  }

  // Voice: on-device Web Speech API where available, else record + Whisper (the
  // /api/voice/transcribe route) so voice works on iOS Safari / in-app WebViews too.
  const { listening, busy: transcribing, toggle: startVoice } = useVoiceInput(
    async (blob) => {
      const fd = new FormData();
      fd.append("file", blob, (blob as File).name || "speech.webm");
      const r = await fetch("/api/voice/transcribe", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      return typeof d.text === "string" ? d.text : "";
    },
    (t) => setInput((p) => (p ? `${p} ${t}` : t)),
  );

  return (
    <div className="flex h-[calc(100vh-13rem)] min-h-[420px] flex-col overflow-hidden rounded-3xl border border-line/60 bg-white/40">
      {/* thread */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="mx-auto max-w-md pt-6 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-gradient text-white shadow-brand">✦</div>
            <p className="mt-3 text-sm font-semibold text-ink">Ask Rani about {businessName}</p>
            <p className="mt-1 text-xs text-ink-soft">Answers come from your own collected data — competitor deals, prices, your rating, what&apos;s trending — plus timely moves for what to run next.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-line bg-white/70 px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-brand/40 hover:text-brand">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "assistant" && <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-gradient text-xs text-white shadow-brand">✦</span>}
            <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${m.role === "user" ? "bg-brand-gradient text-white" : "bg-white/80 text-ink ring-1 ring-line/60"}`}>
              <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
              {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                <div className="mt-2 border-t border-line/50 pt-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Sources</div>
                  <div className="flex flex-wrap gap-1.5">
                    {m.sources.map((s, j) => {
                      const inner = <><span aria-hidden>{SOURCE_EMOJI[s.platform ?? ""] ?? "•"}</span> <span className="font-medium">{s.label}</span>{s.business ? <span className="text-ink-faint"> · {s.business}</span> : null}</>;
                      return s.url
                        ? <a key={j} href={s.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-surface-sunken px-2 py-1 text-[11px] text-ink-soft transition-colors hover:text-brand">{inner}</a>
                        : <span key={j} className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-surface-sunken px-2 py-1 text-[11px] text-ink-soft">{inner}</span>;
                    })}
                  </div>
                </div>
              )}
              {m.role === "assistant" && m.grounded === false && (
                <p className="mt-1 text-[11px] text-ink-faint">Not in your data yet — try a fresh scan.</p>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-gradient text-xs text-white shadow-brand">✦</span>
            <div className="rounded-2xl bg-white/80 px-4 py-3 ring-1 ring-line/60"><span className="rani-dots" aria-label="Thinking"><span /><span /><span /></span></div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* composer */}
      <div className="border-t border-line/60 bg-white/50 p-3">
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={startVoice}
            disabled={busy || transcribing}
            aria-label="Speak your question"
            title={listening ? "Tap to stop" : "Speak instead of typing"}
            className={`grid h-[42px] w-[42px] shrink-0 place-items-center rounded-2xl border transition-colors disabled:opacity-50 ${listening ? "border-brand bg-brand-soft text-brand" : "border-line bg-white/80 text-ink-soft hover:text-brand"}`}
          >
            {transcribing
              ? <span className="rani-dots" aria-label="Transcribing"><span /><span /><span /></span>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>}
          </button>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            rows={1}
            placeholder={listening ? "Listening… tap the mic to stop" : transcribing ? "Transcribing…" : `Ask about ${businessName} or “what should I run this month?”`}
            className="max-h-32 min-h-[42px] w-full resize-none rounded-2xl border border-line bg-white/80 px-3.5 py-2.5 text-sm outline-none focus:border-brand"
          />
          <button onClick={() => send(input)} disabled={busy || !input.trim()} className="btn btn-primary shrink-0 px-4 py-2.5 disabled:opacity-50" aria-label="Send">
            Send
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-ink-faint">Grounded in your collected data · tap the mic to speak · Enter to send</p>
      </div>
    </div>
  );
}
