"use client";

import { useState } from "react";

type Kind = "reply" | "promo" | "content";
interface Draft { caption: string; promoLine: string; sms: string; hashtags: string[] }
interface ReplyArt { reply: string; tone: string }
type Artifact = ({ kind: "reply" } & ReplyArt) | ({ kind: "promo" | "content" } & Draft);

const LABEL: Record<Kind, string> = { reply: "✍️ Draft a reply", promo: "✍️ Draft a response", content: "✍️ Draft a post" };
// Rani (the "do" side) — env-gated deep link so the owner can send the copy to
// their assistant in one hop. Falls back to copy when Rani isn't wired up.
const RANI = (process.env.NEXT_PUBLIC_RANI_URL || "").replace(/\/$/, "");

/**
 * "Act on it" — closes the loop from an insight to a ready-to-send artifact. One
 * tap generates the copy (reply / promo / post); the owner copies it or sends it
 * straight to Rani. This is what makes the intelligence worth paying for.
 */
export function ActOnIt({ kind, move, context, label, small, reviewName }: { kind: Kind; move: string; context?: string; label?: string; small?: boolean; reviewName?: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [art, setArt] = useState<Artifact | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);

  async function postToGoogle() {
    if (!reviewName || !art || art.kind !== "reply") return;
    setPosting(true); setPostErr(null);
    try {
      const r = await fetch("/api/gbp/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewName, comment: art.reply }) });
      const d = await r.json();
      if (!r.ok) setPostErr(d.error ?? "Couldn't post"); else setPosted(true);
    } catch (e) { setPostErr((e as Error).message); } finally { setPosting(false); }
  }

  async function run() {
    setOpen(true);
    if (art || loading) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, move, context }) });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? "Couldn't draft that"); else setArt(d);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }

  const primaryText = art ? (art.kind === "reply" ? art.reply : art.caption) : "";
  const raniHref = RANI && primaryText
    ? `${RANI}/compose?source=insights&kind=${kind}&text=${encodeURIComponent(primaryText)}`
    : "";

  return (
    <>
      <button
        onClick={run}
        className={`inline-flex min-h-[38px] items-center gap-1 rounded-full bg-white/70 font-semibold text-brand-deep transition-colors hover:bg-brand-soft ${small ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm"}`}
      >
        {label ?? LABEL[kind]}
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="glass-strong relative z-10 max-h-[85vh] w-full max-w-lg overflow-auto rounded-3xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">
                  {art?.kind === "reply" ? "Ready to reply" : "Ready to post"}
                </div>
                <p className="mt-0.5 text-sm text-ink-soft">{move}</p>
              </div>
              <button onClick={() => setOpen(false)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-surface-sunken">✕</button>
            </div>

            {loading && <div className="mt-5 flex items-center gap-3"><span className="rani-dots" aria-hidden><span /><span /><span /></span><span className="text-sm text-ink-faint">Writing your copy…</span></div>}
            {err && <p className="mt-4 text-sm text-trust-low">{err}</p>}

            {art && (
              <div className="mt-4 space-y-3">
                {art.kind === "reply" ? (
                  <>
                    <Field label={`Your reply${art.tone ? ` · ${art.tone}` : ""}`} value={art.reply} multiline />
                    {reviewName && (
                      posted ? (
                        <p className="rounded-2xl bg-brand-soft px-3 py-2 text-sm font-medium text-brand-deep">✓ Posted to Google — it&apos;ll appear on your listing shortly.</p>
                      ) : (
                        <>
                          <button onClick={postToGoogle} disabled={posting} className="btn btn-primary w-full justify-center py-2.5 text-sm disabled:opacity-60">
                            {posting ? "Posting…" : "Post this reply to Google →"}
                          </button>
                          {postErr && <p className="text-xs text-trust-low">{postErr}</p>}
                        </>
                      )
                    )}
                  </>
                ) : (
                  <>
                    <Field label="Social caption" value={art.caption} multiline />
                    <Field label="In-store / sign" value={art.promoLine} />
                    <Field label="SMS / WhatsApp blast" value={art.sms} />
                    {art.hashtags.length > 0 && <Field label="Hashtags" value={art.hashtags.map((h) => `#${h}`).join(" ")} />}
                  </>
                )}

                {raniHref && (
                  <a href={raniHref} target="_blank" rel="noopener noreferrer" className="btn btn-primary w-full justify-center py-2.5 text-sm">
                    Send to Rani →
                  </a>
                )}
                <p className="text-[11px] text-ink-faint">Drafted by Ask Rani — tweak before {art.kind === "reply" ? "posting your reply" : "posting"}.</p>
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
