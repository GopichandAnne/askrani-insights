"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Edge } from "@/lib/intel";

/** Compact "Your Edge" teaser for the Today home — the single top move + one
 *  competitor gap, deep-linking into the full Edge page. */
export function EdgeTeaser() {
  const [edge, setEdge] = useState<Edge | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/intel").then((r) => r.json()).then((d) => { if (alive) (d.error ? setFailed(true) : setEdge(d)); }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  if (failed) return null;

  const move = edge?.competitorMoves?.[0];
  const headline = edge?.headline;

  return (
    <Link href="/edge" className="card card-hover glow-hover block">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-brand" aria-hidden>⚡</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Your edge</span>
            <span className="shrink-0 text-xs font-medium text-brand hover:underline">See all →</span>
          </div>

          {!edge ? (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="rani-dots scale-90" aria-hidden><span /><span /><span /></span>
              <span className="text-sm text-ink-faint">Reading your market…</span>
            </div>
          ) : (
            <>
              <p className="mt-0.5 line-clamp-2 font-semibold leading-snug">{headline}</p>
              {move ? (
                <div className="mt-2 rounded-xl bg-white/55 p-2.5">
                  <p className="text-xs text-ink-soft">
                    <span className="font-semibold text-ink">{move.competitor}:</span> {move.move}
                  </p>
                  {move.leverage && (
                    <p className="mt-1 flex items-start gap-1 text-xs text-brand-deep">
                      <span aria-hidden>✦</span><span><span className="font-semibold">Do:</span> {move.leverage}</span>
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-sm text-ink-faint">Attach competitors&apos; social &amp; collect to reveal what they&apos;re doing differently.</p>
              )}
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
