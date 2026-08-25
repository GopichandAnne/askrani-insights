"use client";

import { useState } from "react";

/** On-demand Findability scan trigger. Calls the credit-charged refresh endpoint
 *  (the weekly cron is plan-included; this is the "run it now" button), then
 *  reloads to show the fresh rankings. */
export function FindabilityRefreshButton({ workspaceId, credits }: { workspaceId: string; credits: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function go() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/findability/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.needsCredits) {
        setMsg(`Needs ${data.quote} credits — you have ${data.balance}.`);
      } else if (data?.ok) {
        setMsg("Done — loading your rankings…");
        window.location.reload();
        return;
      } else {
        setMsg(data?.note ?? "Couldn’t run the scan right now — try again shortly.");
      }
    } catch {
      setMsg("Couldn’t run the scan right now — try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={go} disabled={busy} className="btn btn-primary px-4 py-2 text-sm disabled:opacity-60">
        {busy ? "Scanning Google…" : "↻ Track my findability now"}
      </button>
      <span className="text-[11px] text-ink-faint">{credits} credits · ~30–60s{msg ? ` · ${msg}` : ""}</span>
    </div>
  );
}
