"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DraftButton } from "@/components/DraftButton";
import type { Edge } from "@/lib/intel";

/**
 * "Your edge this week" — the synthesis surfaced INLINE on the home (not a teaser
 * that links away): the single biggest lever, then the top competitor moves, each
 * with a one-click "Draft a post" so the owner can act without leaving the page.
 * Folds the old standalone Your Edge page into This Week.
 */
export function EdgeThisWeek() {
  const [edge, setEdge] = useState<Edge | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/intel")
      .then((r) => r.json())
      .then((d) => { if (alive) (d.error ? setFailed(true) : setEdge(d)); })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  if (failed) return null;

  const moves = (edge?.competitorMoves ?? []).slice(0, 3);

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand" aria-hidden>⚡</span>
          Your edge this week
        </h2>
        <Link href="/edge" className="text-xs font-medium text-brand hover:underline">full analysis →</Link>
      </div>

      {!edge ? (
        <div className="mt-4 flex items-center gap-2">
          <span className="rani-dots" aria-hidden><span /><span /><span /></span>
          <span className="text-sm text-ink-faint">Reading your market…</span>
        </div>
      ) : (
        <>
          <p className="mt-3 font-display text-lg font-bold leading-snug tracking-tight">{edge.headline}</p>
          {edge.theEdge && <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">{edge.theEdge}</p>}

          {moves.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">What rivals are doing — and your move</p>
              {moves.map((m, i) => (
                <div key={i} className="rounded-2xl bg-white/55 p-3">
                  <p className="text-sm text-ink-soft">
                    <span className="font-semibold text-ink">{m.competitor}:</span> {m.move}
                  </p>
                  {m.leverage && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="flex-1 text-sm text-brand-deep">
                        <span aria-hidden>✦</span> <span className="font-semibold">Your move:</span> {m.leverage}
                      </p>
                      <DraftButton move={m.leverage} context={`Competitor ${m.competitor}: ${m.move}`} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
