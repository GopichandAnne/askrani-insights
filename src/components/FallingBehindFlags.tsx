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

/** Fresh timing for a festival flag, computed at READ time from occursOn so a cached
 *  flag never shows a stale "happening now". Returns null once it's clearly past. */
function timing(occursOn?: string): string | null {
  if (!occursOn) return "";
  const days = Math.ceil((new Date(occursOn).getTime() - Date.now()) / 86_400_000);
  if (isNaN(days)) return "";
  if (days < -2) return null;                 // occasion is over → drop the flag
  if (days <= 0) return "happening now";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** What a competitor actually did — "Rival: title" → a readable detail line. */
function whatTheyDid(evidence?: string): string | null {
  const e = (evidence ?? "").trim();
  if (!e) return null;
  const i = e.indexOf(":");
  return i > 0 ? `${e.slice(0, i).trim()} posted: “${e.slice(i + 1).trim()}”` : `Seen: “${e}”`;
}

function Flag({ f }: { f: FallingBehindFlag }) {
  const [hidden, setHidden] = useState(false);
  const m = META[f.tag];
  if (hidden) return null;
  const when = timing(f.occursOn);
  if (when === null) return null;             // stale festival — don't show a past occasion
  const detail = whatTheyDid(f.evidence);

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
        <span className="min-w-0 font-display text-base font-extrabold text-ink">{f.concept}</span>
        {when && <span className="shrink-0 rounded-full bg-coral/10 px-2 py-0.5 text-[11px] font-semibold text-coral-dark">{when}</span>}
      </div>
      <p className="mt-1 text-sm text-ink-soft">{line(f)}</p>
      {detail && <p className="mt-1.5 break-words text-sm text-ink-soft"><span className="text-ink-faint">What they did — </span>{detail}</p>}
      {f.rivals.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {f.rivals.slice(0, 4).map((r) => <span key={r} className="chip max-w-full truncate bg-surface-sunken text-ink-faint">{r}</span>)}
        </div>
      )}
      {f.tag === "demand_gap" && f.demandExample && <p className="mt-1 break-words text-xs italic text-ink-faint">“{f.demandExample}”</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <ActOnIt
          kind="content"
          move={f.tag === "behind" ? `Match what competitors are doing: ${f.concept}` : `Test ${f.concept} — customers are asking and few rivals offer it`}
          context={f.evidence || f.demandExample}
          label={f.tag === "demand_gap" ? "Draft a low-cost test" : "Draft a response"}
          small
        />
        <button onClick={weOfferIt} className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-ink-faint hover:text-ink" title="Tell Rani you already offer this so it stops flagging it">
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
