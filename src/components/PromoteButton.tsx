"use client";

import { useState } from "react";

/** "Keep it live — Monitor" — promotes a deep-read snapshot into an ongoing
 *  monitored workspace (credits the scan cost back within the window). `as='area'`
 *  converts it to area monitoring (no "you"); default keeps it as your business.
 *  `variant='secondary'` renders the quieter button for the alternate choice. */
export function PromoteButton({ creditBack, label, as, variant = "primary" }: { creditBack: number; label?: string; as?: "area" | "business"; variant?: "primary" | "secondary" }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function promote() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/workspace/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(as ? { as } : {}) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Couldn't promote"); return; }
      window.location.href = as === "area" ? "/market" : window.location.pathname;
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={promote} disabled={loading} className={`btn shrink-0 px-4 py-2 text-sm disabled:opacity-60 ${variant === "primary" ? "btn-primary" : "btn-secondary"}`}>
        {loading ? "Promoting…" : (label ?? "Keep it live — Monitor →")}
        {creditBack > 0 && !loading ? <span className="ml-1 opacity-80">({creditBack} cr back)</span> : null}
      </button>
      {err && <span className="text-xs text-trust-low">{err}</span>}
    </div>
  );
}
