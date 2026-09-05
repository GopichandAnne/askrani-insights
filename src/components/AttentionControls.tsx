"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MODES, OBJECTIVES, type AttnMode } from "@/lib/attention-prefs";

async function post(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch("/api/attention/prefs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { /* best-effort */ }
}

/** The learning controls (Phase 5): the owner's focus (biases ranking) + how much
 *  Rani interrupts (Quiet / Balanced / Active). Changing either re-ranks the board. */
export function AttentionControls({ mode = "balanced", objective }: { mode?: AttnMode; objective?: string }) {
  const router = useRouter();
  const [m, setM] = useState<AttnMode>(mode);
  const [obj, setObj] = useState<string>(objective ?? "");
  const [busy, setBusy] = useState(false);

  async function pickMode(v: AttnMode) {
    if (v === m || busy) return;
    setM(v); setBusy(true);
    await post({ action: "mode", mode: v });
    setBusy(false); router.refresh();
  }
  async function pickObjective(v: string) {
    setObj(v); setBusy(true);
    await post({ action: "objective", objective: v || null });
    setBusy(false); router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-white/55 px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Focus</span>
        <select
          value={obj}
          onChange={(e) => pickObjective(e.target.value)}
          disabled={busy}
          className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm font-medium text-ink"
        >
          <option value="">No specific focus</option>
          {OBJECTIVES.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
        </select>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Alerts</span>
        <div className="flex rounded-lg border border-line bg-surface-sunken p-0.5">
          {MODES.map((x) => (
            <button
              key={x.slug}
              title={x.hint}
              onClick={() => pickMode(x.slug)}
              disabled={busy}
              className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${m === x.slug ? "bg-surface text-brand shadow-sm" : "text-ink-faint hover:text-brand"}`}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
