"use client";

import { useState } from "react";
import { captureNeed } from "@/lib/contenthelp";

/**
 * "Have our team make this" — a natural, need-triggered offer that appears ONLY on
 * suggestions needing a real visual (reel/poster/post), decided by captureNeed. The
 * free help (caption/plan) stands on its own; this is the optional done-for-you.
 * Remote-edit-first: share a photo/clip and we finish it — or, at the end, we shoot.
 * Captures the request (demand probe); no media upload here.
 */
export function MakeThisButton({ idea, context, format }: { idea: string; context?: string; format?: string }) {
  const need = captureNeed({ format, text: idea });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState("");
  if (!need) return null; // text-only suggestion — no capture need, no offer

  async function submit(capture: "share" | "shoot") {
    if (busy || !need) return;
    setBusy(true);
    try {
      const r = await fetch("/api/content-help", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea, context, capture, kind: need.kind, note }),
      });
      if (r.ok) setDone(true);
    } finally { setBusy(false); }
  }

  if (done) return <p className="text-xs text-trust-direct">✓ Requested — we&apos;ll email a quote and where to send your {need.asset}.</p>;

  if (!open) return (
    <button onClick={() => setOpen(true)} className="text-xs font-medium text-brand-deep hover:underline">
      {need.kind === "video" ? "🎬" : "📸"} Have our team make this {need.output}
    </button>
  );

  return (
    <div className="w-full rounded-xl border border-line bg-white/70 p-2.5 text-xs">
      <p className="text-ink-soft">Share {need.asset} and our team turns it into a finished {need.output} — no editing skills needed.</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Anything we should know? (optional)"
        className="mt-2 w-full resize-none rounded-lg border border-line bg-white/80 px-2 py-1.5 outline-none focus:border-brand"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button onClick={() => submit("share")} disabled={busy} className="rounded-full bg-brand-gradient px-3 py-1.5 font-semibold text-white shadow-brand disabled:opacity-60">
          I&apos;ll share {need.asset} →
        </button>
        <button onClick={() => submit("shoot")} disabled={busy} className="text-ink-faint hover:text-brand">or have us come shoot it</button>
        <button onClick={() => setOpen(false)} className="ml-auto text-ink-faint hover:text-ink">cancel</button>
      </div>
    </div>
  );
}
