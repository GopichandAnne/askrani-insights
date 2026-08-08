"use client";

import { useState } from "react";

/** "Keep it live — Monitor" — promotes a deep-read snapshot into an ongoing
 *  monitored workspace (credits the scan cost back within the window). */
export function PromoteButton({ creditBack, label }: { creditBack: number; label?: string }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function promote() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/workspace/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Couldn't promote"); return; }
      window.location.reload();
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={promote} disabled={loading} className="btn btn-primary shrink-0 px-4 py-2 text-sm disabled:opacity-60">
        {loading ? "Promoting…" : (label ?? "Keep it live — Monitor →")}
        {creditBack > 0 && !loading ? <span className="ml-1 opacity-80">({creditBack} cr back)</span> : null}
      </button>
      {err && <span className="text-xs text-trust-low">{err}</span>}
    </div>
  );
}
