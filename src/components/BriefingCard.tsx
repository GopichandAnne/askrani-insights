"use client";

import { useEffect, useState } from "react";
import { RaniMark } from "@/components/RaniSpinner";

/** The hero "weekly briefing" on Home — fetches the cached/generated summary and
 *  shows a friendly loading state so the page renders instantly. */
export function BriefingCard() {
  const [b, setB] = useState<{ headline: string; summary: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/briefing")
      .then((r) => r.json())
      .then((d) => { if (alive) setB(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return (
    <section className="glass-strong relative overflow-hidden rounded-3xl p-6">
      <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.08]" aria-hidden />
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-brand/15 blur-2xl" aria-hidden />
      <div className="relative flex items-start gap-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand-gradient text-white shadow-brand">
          <RaniMark size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Your weekly briefing</div>
          {!b && !failed ? (
            <div className="mt-2 flex items-center gap-3">
              <span className="rani-dots" aria-hidden><span /><span /><span /></span>
              <span className="text-sm text-ink-faint">Reading your market…</span>
            </div>
          ) : failed || !b?.summary ? (
            <p className="mt-1 text-ink-soft">Your briefing will appear here once we&apos;ve gathered your market. Try “Start collecting”.</p>
          ) : (
            <>
              <h2 className="mt-1 font-display text-2xl font-extrabold leading-tight tracking-tight">{b.headline}</h2>
              <p className="mt-2 max-w-3xl text-ink-soft">{b.summary}</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
