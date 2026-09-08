"use client";

import { useState } from "react";
import type { FallingBehindFlag } from "@/lib/fallingbehind";
import { ActOnIt } from "@/components/ActOnIt";

/**
 * Client flag list for the "falling behind" lane. Each flag carries a subtle
 * "We already offer this" action → posts the concept to goals.weOffer and
 * optimistically hides it, so the owner teaches the detector the target-gap when
 * their menu isn't collected. Pure presentation otherwise.
 */

const META: Record<FallingBehindFlag["tag"], { icon: string; label: string; cls: string }> = {
  demand_moving: { icon: "🎯", label: "Rising · rivals moving", cls: "border-l-coral bg-coral/5" },
  behind: { icon: "🔻", label: "Falling behind", cls: "border-l-brand bg-brand-soft/40" },
  demand_gap: { icon: "🌱", label: "Early signal · low confidence", cls: "border-l-line bg-surface-sunken/60" },
};

function line(f: FallingBehindFlag): string {
  if (f.tag === "behind") return `${f.rivalCount} of your competitors run this — you don't.`;
  if (f.tag === "demand_moving") return `Customers keep asking, and ${f.rivalCount} rival${f.rivalCount === 1 ? " has" : "s have"} started — you haven't.`;
  return "Customers keep asking for this and few rivals offer it — worth a low-cost test.";
}

function Flag({ f }: { f: FallingBehindFlag }) {
  const [hidden, setHidden] = useState(false);
  const m = META[f.tag];
  if (hidden) return null;

  async function weOfferIt() {
    setHidden(true); // optimistic — the detector will exclude it on next refresh
    try {
      await fetch("/api/falling-behind/offered", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ concept: f.concept }),
      });
    } catch { /* best-effort; stays hidden this session regardless */ }
  }

  return (
    <div className={`rounded-xl border-l-[3px] ${m.cls} p-3`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{m.icon} {m.label}</span>
        <span className="font-display text-base font-extrabold text-ink">{f.concept}</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{line(f)}</p>
      {f.rivals.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {f.rivals.slice(0, 4).map((r) => <span key={r} className="chip bg-surface-sunken text-ink-faint">{r}</span>)}
        </div>
      )}
      {f.tag === "demand_gap" && f.demandExample && <p className="mt-1 text-xs italic text-ink-faint">“{f.demandExample}”</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <ActOnIt
          kind="content"
          move={f.tag === "behind" ? `Match what competitors are doing: ${f.concept}` : `Test ${f.concept} — customers are asking and few rivals offer it`}
          context={f.evidence || f.demandExample}
          label={f.tag === "demand_gap" ? "Draft a low-cost test" : "Draft a response"}
          small
        />
        <button onClick={weOfferIt} className="text-xs font-medium text-ink-faint transition-colors hover:text-ink" title="Tell Rani you already offer this so it stops flagging it">
          We already offer this
        </button>
      </div>
    </div>
  );
}

export function FallingBehindFlags({ flags }: { flags: FallingBehindFlag[] }) {
  return (
    <div className="space-y-2.5">
      {flags.map((f, i) => <Flag key={`${f.concept}-${i}`} f={f} />)}
    </div>
  );
}
