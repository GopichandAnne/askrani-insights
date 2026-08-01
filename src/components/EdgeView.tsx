"use client";

import { useEffect, useState } from "react";
import { RaniMark } from "@/components/RaniSpinner";
import type { Edge } from "@/lib/intel";

/** "Your Edge" — the synthesized value view. Fetches the cached brief, renders
 *  each signal dimension as an at-a-glance card with a concrete leverage move. */
export function EdgeView() {
  const [edge, setEdge] = useState<Edge | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/intel").then((r) => r.json()).then((d) => { if (alive) (d.error ? setFailed(true) : setEdge(d)); }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await fetch("/api/intel", { method: "POST" });
      const d = await r.json();
      if (!d.error) setEdge(d);
    } finally { setRefreshing(false); }
  }

  if (failed) return <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">Set up a business first — then your edge appears here.</p>;
  if (!edge) return (
    <div className="glass-strong flex items-center gap-3 rounded-3xl p-6">
      <span className="rani-dots" aria-hidden><span /><span /><span /></span>
      <span className="text-sm text-ink-soft">Reading your whole market — competitors, reviews, trends…</span>
    </div>
  );

  const has = (a: unknown[]) => a && a.length > 0;

  return (
    <div className="space-y-6">
      {/* hero */}
      <section className="glass-strong relative overflow-hidden rounded-3xl p-6">
        <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.08]" aria-hidden />
        <div className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-brand/15 blur-2xl" aria-hidden />
        <div className="relative flex items-start gap-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-gradient text-white shadow-brand"><RaniMark size={24} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Your edge right now</div>
              <button onClick={refresh} disabled={refreshing} className="btn btn-secondary shrink-0 px-3 py-1.5 text-xs disabled:opacity-60">{refreshing ? "Rethinking…" : "↻ Refresh"}</button>
            </div>
            <h2 className="mt-1 font-display text-2xl font-extrabold leading-tight tracking-tight">{edge.headline}</h2>
            <p className="mt-2 max-w-3xl text-ink-soft">{edge.theEdge}</p>
          </div>
        </div>
      </section>

      {edge.dataThin && (
        <p className="rounded-2xl border border-dashed border-line bg-surface-sunken/50 p-3 text-sm text-ink-faint">
          This is based on limited data so far. Attach competitors&apos; social in <span className="font-medium text-brand-deep">Channels</span> and run a collection to sharpen it.
        </p>
      )}

      {/* competitor moves */}
      {has(edge.competitorMoves) && (
        <Section icon="🎯" title="What competitors are doing differently" sub="Moves your rivals are making that you aren't — and how to answer.">
          <div className="grid gap-3 md:grid-cols-2">
            {edge.competitorMoves.map((m, i) => (
              <div key={i} className="flex flex-col rounded-2xl bg-white/55 p-4">
                <div className="flex items-center gap-2">
                  <span className="chip bg-brand-soft text-brand-deep">{m.competitor}</span>
                  <span className="chip bg-surface-sunken text-ink-soft">{m.category}</span>
                </div>
                <p className="mt-2 text-sm font-medium text-ink">{m.move}</p>
                <p className="mt-1 text-xs text-ink-faint">vs you: {m.differsFromYou}</p>
                <Leverage text={m.leverage} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* sentiment */}
      {(has(edge.sentiment.loves) || has(edge.sentiment.gripes) || edge.sentiment.aboutYou) && (
        <Section icon="💬" title="What people really think" sub="Themes from reviews & social — beyond the star rating.">
          {edge.sentiment.aboutYou && <p className="mb-3 text-sm text-ink-soft"><span className="font-semibold text-ink">About you:</span> {edge.sentiment.aboutYou}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <ThemeList tone="love" title="What they love" items={edge.sentiment.loves} />
            <ThemeList tone="gripe" title="Gaps & gripes" items={edge.sentiment.gripes} />
          </div>
          {edge.sentiment.marketSummary && <p className="mt-3 text-xs text-ink-faint">{edge.sentiment.marketSummary}</p>}
        </Section>
      )}

      {/* trends */}
      {has(edge.trends) && (
        <Section icon="📈" title="Trends to ride" sub="What's moving in your field — and how to use it.">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {edge.trends.map((t, i) => (
              <div key={i} className="flex flex-col rounded-2xl bg-white/55 p-4">
                <p className="text-sm font-semibold text-ink">{t.trend}</p>
                <p className="mt-1 text-xs text-ink-faint">{t.why}</p>
                <Leverage text={t.leverage} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* winning offerings */}
      {has(edge.winningOfferings) && (
        <Section icon="🏆" title="Offerings that are winning" sub="Products & formats working in this market you could adopt.">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {edge.winningOfferings.map((o, i) => (
              <div key={i} className="flex flex-col rounded-2xl bg-white/55 p-4">
                <p className="text-sm font-semibold text-ink">{o.offering}</p>
                <p className="mt-1 text-xs text-ink-faint">{o.evidence}</p>
                <Leverage text={o.leverage} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* events */}
      {has(edge.events) && (
        <Section icon="📅" title="Moments to prepare for" sub="Upcoming events & seasonal peaks worth planning around.">
          <ul className="space-y-2">
            {edge.events.map((e, i) => (
              <li key={i} className="rounded-2xl bg-white/55 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{e.title}</span>
                  {e.when && <span className="chip bg-coral/15 text-coral-dark">{e.when}</span>}
                </div>
                <p className="mt-1 text-xs text-ink-faint">{e.why}</p>
                <Leverage text={e.action} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <p className="px-1 text-[11px] text-ink-faint">Synthesized by Ask Rani from your collected signals · updated {new Date(edge.at).toLocaleString()}</p>
    </div>
  );
}

function Section({ icon, title, sub, children }: { icon: string; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-soft text-base" aria-hidden>{icon}</span>
        <div>
          <h3 className="font-semibold leading-tight">{title}</h3>
          <p className="text-xs text-ink-faint">{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Leverage({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded-xl bg-brand-soft/60 px-2.5 py-1.5 text-xs text-brand-deep">
      <span aria-hidden>✦</span>
      <span><span className="font-semibold">Leverage:</span> {text}</span>
    </div>
  );
}

function ThemeList({ tone, title, items }: { tone: "love" | "gripe"; title: string; items: string[] }) {
  const dot = tone === "love" ? "text-trust-direct" : "text-coral-dark";
  return (
    <div className="rounded-2xl bg-white/55 p-3.5">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-faint">Not enough signal yet.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-1.5 text-sm text-ink-soft">
              <span className={`mt-0.5 shrink-0 ${dot}`} aria-hidden>{tone === "love" ? "▲" : "▼"}</span>
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
