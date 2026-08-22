"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * On-demand "refresh everything" — enqueues a full monitoring refresh for the active
 * workspace (collection + the flyer/image + ads stages). The app-wide CollectionBanner
 * then shows live progress, so the scrape isn't left to the imagination. Costs credits
 * (monitoring runs on them); blocks with a clear message when the balance is empty.
 */
export function RefreshButton({ workspaceId, className = "" }: { workspaceId: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();

  async function run() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/collect/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.needsCredits) setMsg({ ok: false, text: `Not enough credits (balance ${d.balance ?? 0}). Top up in Billing.` });
      else if (d.error) setMsg({ ok: false, text: "Couldn't start — try again." });
      else if ((d.enqueued ?? 0) === 0) setMsg({ ok: true, text: "Already up to date — nothing new to scan." });
      else { setMsg({ ok: true, text: "Refreshing your market — progress shows above." }); router.refresh(); }
    } catch {
      setMsg({ ok: false, text: "Couldn't start — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <button onClick={run} disabled={busy} className="btn btn-secondary px-3 py-1.5 text-sm disabled:opacity-60">
        {busy ? "Starting…" : "🔄 Refresh data"}
      </button>
      {msg && <span className={`text-xs ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</span>}
    </span>
  );
}
