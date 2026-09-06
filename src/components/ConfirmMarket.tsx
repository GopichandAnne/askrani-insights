"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Did Rani get your market right?" — the confirm-your-competitors step. Every
 * action here both cleans the owner's set AND banks a labeled competitive
 * relationship (competitor_label) that we learn from. Keep it light: a big
 * "Looks right", a per-row remove with a reason, and an add box.
 */
const REASONS: { key: string; label: string }[] = [
  { key: "different_customers", label: "Different customers" },
  { key: "too_far", label: "Too far away" },
  { key: "different_price", label: "Different price level" },
  { key: "different_concept", label: "Different concept" },
  { key: "other", label: "Other" },
];

interface Comp { id: string; name: string; match?: number }

export function ConfirmMarket({ competitors }: { competitors: Comp[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Comp[]>(competitors);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [addName, setAddName] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  if (!competitors.length) return null;

  async function post(body: Record<string, unknown>) {
    return fetch("/api/competitors/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async function confirmAll() {
    if (busy) return; setBusy(true);
    try { await post({ action: "confirm_all" }); setDone(true); } finally { setBusy(false); }
  }
  async function reject(id: string, reason: string) {
    setRemoving(null);
    setRows((r) => r.filter((c) => c.id !== id));
    await post({ action: "reject", competitorId: id, reason });
    router.refresh();
  }
  async function add() {
    const name = addName.trim(); if (!name || busy) return;
    setBusy(true);
    try { await post({ action: "add", name }); setAdded((a) => [...a, name]); setAddName(""); } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Did Rani get your market right?</h2>
          <p className="mt-0.5 text-sm text-ink-faint">Confirm the businesses you actually compete with — it sharpens every insight, and teaches Rani.</p>
        </div>
        {done
          ? <span className="text-sm font-medium text-trust-direct">✓ Thanks — saved</span>
          : <button onClick={confirmAll} disabled={busy} className="btn btn-primary px-4 py-2 text-sm disabled:opacity-50">Looks right</button>}
      </div>

      <ul className="mt-4 divide-y divide-line/60">
        {rows.map((c) => (
          <li key={c.id} className="py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink">{c.name}{typeof c.match === "number" ? <span className="ml-2 text-[11px] text-ink-faint">{Math.round(c.match * 100)}% match</span> : null}</span>
              {removing === c.id
                ? <span className="text-[11px] text-ink-faint">Why?</span>
                : <button onClick={() => setRemoving(c.id)} className="text-xs text-ink-faint underline-offset-2 hover:text-coral-dark hover:underline">Remove</button>}
            </div>
            {removing === c.id && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {REASONS.map((r) => (
                  <button key={r.key} onClick={() => reject(c.id, r.key)} className="rounded-full border border-line bg-white/70 px-2.5 py-1 text-[11px] text-ink-soft transition-colors hover:border-brand/40 hover:text-brand">{r.label}</button>
                ))}
                <button onClick={() => setRemoving(null)} className="px-2 py-1 text-[11px] text-ink-faint">cancel</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Missing a competitor? Add their name"
          className="min-w-[220px] flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <button onClick={add} disabled={busy || !addName.trim()} className="rounded-xl border border-line bg-white/70 px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50">Add</button>
      </div>
      {added.length > 0 && <p className="mt-1.5 text-[11px] text-ink-faint">Noted: {added.join(", ")} — Rani will factor these in.</p>}
    </section>
  );
}
