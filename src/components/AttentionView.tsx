"use client";

import { useEffect, useState } from "react";
import type { AttentionBoard, AttentionItem, AttnClass } from "@/lib/attention";
import { ActOnIt } from "@/components/ActOnIt";
import { anchorFor } from "@/lib/anchor";

// A = needs attention (coral), B = opportunity (teal/brand), C = watch (neutral).
const CLS: Record<AttnClass, { chip: string; stripe: string }> = {
  A: { chip: "bg-coral/15 text-coral-dark", stripe: "bg-coral" },
  B: { chip: "bg-brand-soft text-brand-deep", stripe: "bg-brand" },
  C: { chip: "bg-surface-sunken text-ink-soft", stripe: "bg-ink-faint/40" },
};

function Card({ it }: { it: AttentionItem }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [thanked, setThanked] = useState(false);
  const s = CLS[it.cls] ?? CLS.C;

  // Feedback = the learning signal. "Useful" keeps this kind prominent; "Ignore"
  // hides it and teaches Rani to show less of that kind over time.
  async function feedback(signal: "useful" | "dismiss") {
    if (signal === "dismiss") setDismissed(true); else setThanked(true);
    try {
      await fetch("/api/attention/prefs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "feedback", kind: it.kind, signal }),
      });
    } catch { /* best-effort learning */ }
  }
  if (dismissed) return null;

  return (
    <div id={anchorFor(it.id)} className="card flex gap-3.5 scroll-mt-24 overflow-hidden p-0 transition-shadow">
      <div className={`w-1 shrink-0 rounded-full ${s.stripe}`} />
      <div className="min-w-0 flex-1 py-4 pr-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip font-semibold ${s.chip}`}>{it.label}</span>
          <span className="text-xs font-medium text-ink-faint">{it.icon} {it.category}</span>
        </div>
        <h3 className="mt-1.5 text-base font-bold leading-snug text-ink">{it.headline}</h3>

        {open && it.take && (
          <p className="mt-2 rounded-2xl bg-surface-sunken/70 p-3 text-sm text-ink-soft">{it.take}</p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {it.take && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="inline-flex min-h-[38px] items-center rounded-full border border-line bg-white/60 px-3.5 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-brand hover:text-brand"
            >
              {open ? "Hide" : "Why this?"}
            </button>
          )}
          {it.act && <ActOnIt kind={it.act.kind} move={it.act.move} context={it.act.context} small />}
          {it.href && (
            <a href={it.href} className="inline-flex min-h-[38px] items-center text-xs font-semibold text-brand hover:underline">
              See details →
            </a>
          )}
          <span className="ml-auto flex items-center gap-1 text-ink-faint">
            {thanked ? (
              <span className="px-1 text-xs font-medium text-brand-deep">Thanks ✓</span>
            ) : (
              <>
                <button onClick={() => feedback("useful")} title="Useful — keep these coming" className="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-brand-soft hover:text-brand">👍</button>
                <button onClick={() => feedback("dismiss")} title="Show less like this" className="inline-flex min-h-[32px] items-center rounded-full px-2 text-xs font-medium transition-colors hover:text-coral-dark">Ignore</button>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function MoreRow({ it }: { it: AttentionItem }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/55 px-3.5 py-2.5">
      <span aria-hidden className="text-lg">{it.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{it.headline}</p>
        <p className="text-[11px] uppercase tracking-wide text-ink-faint">{it.category}</p>
      </div>
      {it.href && <a href={it.href} className="shrink-0 text-xs font-medium text-brand hover:underline">See →</a>}
    </div>
  );
}

export function AttentionView({ board }: { board: AttentionBoard }) {
  const [showAll, setShowAll] = useState(false);
  const more = showAll ? board.more : board.more.slice(0, 6);

  // Deep-link arrival: a brief's link lands on /brief#<item>; scroll to it + flash.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-brand", "ring-offset-2");
    const t = setTimeout(() => el.classList.remove("ring-2", "ring-brand", "ring-offset-2"), 2600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="space-y-6">
      {/* the 2-4 that need attention */}
      {board.items.length > 0 ? (
        <section className="space-y-3">
          {board.items.map((it) => <Card key={it.id} it={it} />)}
        </section>
      ) : (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft"><span className="font-semibold text-ink">Nothing needs your attention right now.</span> Rani is watching your market and will surface anything that matters.</p>
        </div>
      )}

      {/* everything else moving — the breadth, one glance away */}
      {board.more.length > 0 && (
        <section>
          <h2 className="mb-2.5 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📡</span>
            Everything moving in your market
            <span className="ml-1 text-xs font-normal text-ink-faint">{board.more.length} signals · sorted by significance</span>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {more.map((it) => <MoreRow key={it.id} it={it} />)}
          </div>
          {board.more.length > 6 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mt-3 inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold text-brand-deep hover:bg-brand-soft/60"
            >
              {showAll ? "Show fewer" : `Show ${board.more.length - 6} more`} <span aria-hidden>›</span>
            </button>
          )}
        </section>
      )}

      {/* stable-state reassurance */}
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">✓</span>
        <span>
          <span className="font-semibold text-ink">Everything else is stable.</span> Rani weighed {board.checkedCount} signal{board.checkedCount === 1 ? "" : "s"} across your market — {board.stableCount} {board.stableCount === 1 ? "is" : "are"} steady and {board.items.length ? "the rest are above" : "nothing needs you today"}.
        </span>
      </div>
    </div>
  );
}
