"use client";

import { useState } from "react";

interface Draft { caption: string; promoLine: string; sms: string; hashtags: string[]; }

/** "Act on it" — turns a recommended move into ready-to-post copy in a modal. */
export function DraftButton({ move, context }: { move: string; context?: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setOpen(true);
    if (draft || loading) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ move, context }) });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? "Couldn't draft that"); else setDraft(d);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }

  return (
    <>
      <button onClick={run} className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-brand-deep transition-colors hover:bg-brand-soft">
        ✍️ Draft a post
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="glass-strong relative z-10 max-h-[85vh] w-full max-w-lg overflow-auto rounded-3xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Ready to post</div>
                <p className="mt-0.5 text-sm text-ink-soft">{move}</p>
              </div>
              <button onClick={() => setOpen(false)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-surface-sunken">✕</button>
            </div>

            {loading && <div className="mt-5 flex items-center gap-3"><span className="rani-dots" aria-hidden><span /><span /><span /></span><span className="text-sm text-ink-faint">Writing your copy…</span></div>}
            {err && <p className="mt-4 text-sm text-trust-low">{err}</p>}

            {draft && (
              <div className="mt-4 space-y-3">
                <Field label="Social caption" value={draft.caption} multiline />
                <Field label="In-store / sign" value={draft.promoLine} />
                <Field label="SMS / WhatsApp blast" value={draft.sms} />
                {draft.hashtags.length > 0 && <Field label="Hashtags" value={draft.hashtags.map((h) => `#${h}`).join(" ")} />}
                <p className="text-[11px] text-ink-faint">Drafted by Ask Rani — tweak before posting.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Field({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="rounded-2xl bg-white/60 p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
        <button onClick={copy} className="text-[11px] font-medium text-brand hover:underline">{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      <p className={`text-sm text-ink ${multiline ? "whitespace-pre-wrap" : ""}`}>{value}</p>
    </div>
  );
}
