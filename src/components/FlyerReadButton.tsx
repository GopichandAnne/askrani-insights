"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Owner-triggered "read rivals' sale flyers" — starts an async job (charges
 * credits), then drives /api/flyers/tick batch-by-batch, showing live progress
 * and refreshing the page as deals accumulate.
 */
export function FlyerReadButton({ workspaceId, cost }: { workspaceId: string; cost: number }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setBusy(true); setMsg(null); setProgress("Starting…");
    try {
      const r = await fetch("/api/flyers/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
      const d = await r.json();
      if (d.activated === false) { setMsg(d.reason ?? "Not enabled yet."); return; }
      if (r.status === 402) { setMsg(`Not enough credits — needs ${d.needed}.`); return; }
      if (d.error) { setMsg(d.error); return; }
      if (d.status !== "running") { setMsg(d.reason ?? "Nothing to read."); return; }

      // drive ticks until done (bounded so a stuck run can't loop forever)
      let lastDeals = 0;
      for (let i = 0; i < 40; i++) {
        setProgress(`Reading flyers… ${Math.min(i * 2, d.total)}/${d.total} pages`);
        const tr = await fetch("/api/flyers/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
        const td = await tr.json();
        if (td.error) { setMsg(td.error); break; }
        setProgress(`Reading flyers… ${td.processed}/${td.total} pages · ${td.deals} deals`);
        if (td.deals !== lastDeals) { lastDeals = td.deals; router.refresh(); }
        if (td.status === "done") {
          setMsg(td.deals > 0 ? `Done — ${td.deals} flyer deals from ${td.flyersRead} flyers.` : "No sale flyers found on their pages (charge refunded).");
          router.refresh();
          break;
        }
        if (td.status === "idle") { setMsg("Nothing to read."); break; }
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={run} disabled={busy} className="btn btn-secondary px-4 py-2 text-sm disabled:opacity-60">
        {busy ? (progress ?? "Reading flyers…") : `🧾 Read their sale flyers · ${cost} credits`}
      </button>
      {msg && <span className="text-xs text-ink-faint">{msg}</span>}
    </div>
  );
}
