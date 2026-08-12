"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Owner-triggered "read rivals' sale flyers" — charges credits, scrapes + vision-
 *  reads the flyer images, then refreshes the page to show the extracted deals. */
export function FlyerReadButton({ workspaceId, cost }: { workspaceId: string; cost: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/flyers/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
      const d = await r.json();
      if (d.activated === false) setMsg(d.reason ?? "Not enabled yet.");
      else if (r.status === 402) setMsg(`Not enough credits — needs ${d.needed}.`);
      else if (d.error) setMsg(d.error);
      else if (d.deals > 0) { setMsg(`Read ${d.deals} deals from ${d.flyers} flyers.`); router.refresh(); }
      else { setMsg(d.reason ?? "No flyer deals found (charge refunded)."); }
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={run} disabled={busy} className="btn btn-secondary px-4 py-2 text-sm disabled:opacity-60">
        {busy ? "Reading flyers… (~1 min)" : `🧾 Read their sale flyers · ${cost} credits`}
      </button>
      {msg && <span className="text-xs text-ink-faint">{msg}</span>}
    </div>
  );
}
