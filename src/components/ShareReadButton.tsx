"use client";

import { useState } from "react";

/**
 * Creates a public, claimable "free market read" link for this scorecard and copies
 * it — the shareable artifact for outreach / the launch. Stable link (reused token).
 */
export function ShareReadButton() {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function share() {
    if (busy) return;
    setBusy(true); setErr(null); setCopied(false);
    try {
      const r = await fetch("/api/scorecard/share", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) { setErr(d.error ?? "Couldn't create a link"); return; }
      setUrl(d.url);
      try { await navigator.clipboard.writeText(d.url); setCopied(true); } catch { /* clipboard may be blocked */ }
    } catch { setErr("Couldn't create a link"); } finally { setBusy(false); }
  }

  return (
    <div className="text-right">
      <button onClick={share} disabled={busy} className="btn btn-secondary text-sm disabled:opacity-60">
        {busy ? "Creating…" : "🔗 Share this read"}
      </button>
      {url && <p className="mt-1 text-xs text-ink-faint">{copied ? "Copied · " : ""}<a href={url} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">{url.replace(/^https?:\/\//, "")}</a></p>}
      {err && <p className="mt-1 text-xs text-coral-dark">{err}</p>}
    </div>
  );
}
