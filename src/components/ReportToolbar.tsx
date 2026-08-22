"use client";

import { useState } from "react";

/**
 * Report actions: download the branded PDF, the organised Excel workbook, email it
 * on demand (spends credits), and print. Client-only because it calls window.print()
 * and posts the on-demand send; the PDF/Excel links are plain downloads.
 */
export function ReportToolbar({ canSend = false, sendCost = 5 }: { canSend?: boolean; sendCost?: number }) {
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function sendNow() {
    if (sending) return;
    setSending(true); setMsg(null);
    try {
      const r = await fetch("/api/reports/send", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMsg({ ok: true, text: `Sent to ${d.to ?? "your inbox"} · ${d.charged ?? sendCost} credits` });
      else if (r.status === 402) setMsg({ ok: false, text: `Not enough credits (needs ${d.need ?? sendCost})` });
      else if (d.error === "no_recipient") setMsg({ ok: false, text: "No email on file — set one in Channels" });
      else setMsg({ ok: false, text: "Couldn't send — try again" });
    } catch {
      setMsg({ ok: false, text: "Couldn't send — try again" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <a href="/api/reports/pdf?period=weekly" className="btn btn-primary">
        📄 Download PDF report
      </a>
      <a href="/api/reports/export?period=weekly" className="btn btn-secondary">
        📊 Download Excel workbook
      </a>
      {canSend && (
        <button onClick={sendNow} disabled={sending} className="btn btn-secondary disabled:opacity-60">
          {sending ? "Sending…" : `✉️ Email me this report (${sendCost} credits)`}
        </button>
      )}
      <button onClick={() => window.print()} className="btn btn-secondary">
        Print this page
      </button>
      {msg && (
        <span className={`w-full text-xs ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</span>
      )}
    </div>
  );
}
