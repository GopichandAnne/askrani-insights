"use client";

import { useState } from "react";

/**
 * "Get found by AI" add-on — publish + manage a public, AI-ready listing for the
 * business (menu, prices, hours, FAQ in clean crawlable HTML). Credit-gated. Honest
 * about what it is: a controllable, always-fresh page that complements your Google/
 * Yelp presence — not a magic ranking switch.
 */
export function AiPageCard({ initial, cost }: { initial: { published: boolean; url?: string; updatedAt?: string }; cost: number }) {
  const [published, setPublished] = useState(initial.published);
  const [url, setUrl] = useState(initial.url);
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function publish() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/aipage/publish", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (d.needsCredits) { setMsg({ ok: false, text: `Needs ${d.quote} credits — you have ${d.balance}.` }); return; }
      if (r.ok && d.url) {
        const wasPublished = published;
        setPublished(true); setUrl(d.url); setUpdatedAt(d.updatedAt);
        setMsg({ ok: true, text: wasPublished ? "Refreshed & re-submitted to search." : "Published & submitted to search." });
      } else {
        setMsg({ ok: false, text: d.error === "not_enough_data" ? "Not enough collected data yet — run a scan first." : "Couldn't publish — try again." });
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't publish — try again." });
    } finally { setBusy(false); }
  }

  const when = updatedAt ? new Date(updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;

  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">✨</span>
            Get found by AI
          </h2>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Publish a clean, always-current listing of your menu, prices, hours &amp; FAQ that AI assistants and search can read and cite. We generate it from your data and keep it fresh.
          </p>
        </div>
        <button onClick={publish} disabled={busy} className="btn btn-primary shrink-0 px-4 py-2 text-sm disabled:opacity-60">
          {busy ? "Working…" : published ? `Refresh · ${cost} credits` : `Publish · ${cost} credits`}
        </button>
      </div>

      {published && url && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface-sunken px-3.5 py-2.5 text-sm">
          <span className="font-semibold text-trust-direct">● Live</span>
          <a href={url} target="_blank" rel="noreferrer" className="truncate text-brand-deep underline">{url.replace(/^https?:\/\//, "")}</a>
          {when && <span className="text-ink-faint">· updated {when}</span>}
        </div>
      )}

      {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</p>}

      <p className="mt-3 text-[11px] text-ink-faint">
        Complements your Google Business Profile &amp; Yelp — the surfaces AI leans on most. Point your own domain at it later for maximum authority.
      </p>
    </section>
  );
}
