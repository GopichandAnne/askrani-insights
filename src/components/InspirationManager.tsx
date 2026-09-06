"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manage the inspiration watchlist — star the tracked businesses you want to
 * emulate. Kept separate from the competitor rank/price set; toggling just writes
 * goals.inspirationWatch via /api/inspiration and refreshes the pillar.
 */
export function InspirationManager({ watch, candidates }: { watch: string[]; candidates: { id: string; name: string }[] }) {
  const router = useRouter();
  const [set, setSet] = useState<Set<string>>(new Set(watch));
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(id: string) {
    if (busy) return;
    const adding = !set.has(id);
    setBusy(id);
    try {
      const r = await fetch("/api/inspiration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: adding ? "add" : "remove", businessId: id }),
      });
      if (r.ok) {
        setSet((s) => { const n = new Set(s); if (adding) n.add(id); else n.delete(id); return n; });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  if (!candidates.length) {
    return <p className="text-sm text-ink-faint">No businesses to watch yet — once competitors are collected, you can star ones to emulate.</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {candidates.map((c) => {
        const on = set.has(c.id);
        return (
          <button
            key={c.id}
            onClick={() => toggle(c.id)}
            disabled={busy === c.id}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${on ? "border-brand bg-brand-soft text-brand" : "border-line bg-white/70 text-ink-soft hover:border-brand/40 hover:text-brand"}`}
          >
            <span aria-hidden>{on ? "★" : "☆"}</span> {c.name}
          </button>
        );
      })}
    </div>
  );
}
