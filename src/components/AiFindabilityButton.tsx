"use client";

import { useState } from "react";

/** Run the AI-findability scan on demand — asks search-grounded AI assistants
 *  (Perplexity / ChatGPT-search) who they'd recommend for the tracked searches,
 *  then reloads to show the AI ring. Needs a search-grounded engine key set; if
 *  none returned results it says so instead of silently showing "no data". */
export function AiFindabilityButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function go() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/aifindability/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await res.json().catch(() => ({}));
      if (d?.ok && !d.empty) {
        setMsg("Done — loading…");
        window.location.reload();
        return;
      }
      if (d?.ok && d.empty) {
        const seesKey = d?.configured?.perplexity || d?.configured?.openai;
        if (!seesKey) {
          setMsg("No search key detected in the server yet — add PERPLEXITY_API_KEY in Vercel and redeploy (env changes need a fresh deploy).");
        } else if (d?.note) {
          setMsg(`Engine issue: ${d.note}`); // e.g. "Perplexity 402: insufficient credits"
        } else {
          setMsg("Ran, but the AI returned no local businesses this time.");
        }
      } else {
        setMsg(d?.error ?? "Couldn’t run right now — try again shortly.");
      }
    } catch {
      setMsg("Couldn’t run right now — try again shortly.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={go} disabled={busy} className="btn btn-secondary px-4 py-2 text-sm disabled:opacity-60">
        {busy ? "Asking the AIs…" : "✦ Check AI search"}
      </button>
      {msg && <span className="max-w-[16rem] text-right text-[11px] text-ink-faint">{msg}</span>}
    </div>
  );
}
