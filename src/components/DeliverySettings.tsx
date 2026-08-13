"use client";

import { useState } from "react";

/**
 * Where the report is delivered — an email override (optional; the owner's login
 * email is used otherwise) and a WhatsApp number (required to enable the WhatsApp
 * channel). Saves to goals via /api/reports/recipients. Channel-readiness flags
 * tell the owner whether the transport is switched on yet.
 */
export function DeliverySettings({
  initialEmail = "",
  initialWhatsApp = "",
  emailReady = false,
  whatsappReady = false,
}: {
  initialEmail?: string;
  initialWhatsApp?: string;
  emailReady?: boolean;
  whatsappReady?: boolean;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [whatsapp, setWhatsapp] = useState(initialWhatsApp);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/reports/recipients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, whatsapp }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMsg({ ok: true, text: "Saved." });
      else if (d.error === "bad_number") setMsg({ ok: false, text: "That WhatsApp number doesn't look right — include the country code." });
      else if (d.error === "bad_email") setMsg({ ok: false, text: "That email doesn't look right." });
      else setMsg({ ok: false, text: "Couldn't save — try again." });
    } catch {
      setMsg({ ok: false, text: "Couldn't save — try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card no-print">
      <h2 className="flex items-center gap-2 font-semibold">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📬</span>
        Where your report is delivered
      </h2>
      <p className="mt-1 text-xs text-ink-faint">We send your report on your plan&apos;s cadence, and whenever you send one on demand.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="font-medium text-ink">Email {emailReady ? "" : <span className="text-ink-faint">· channel off</span>}</span>
          <input
            type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Defaults to your login email"
            className="mt-1 w-full rounded-xl border border-line bg-white/70 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-ink">WhatsApp number {whatsappReady ? "" : <span className="text-ink-faint">· channel off</span>}</span>
          <input
            type="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)}
            placeholder="e.g. +1 512 555 0142 (with country code)"
            className="mt-1 w-full rounded-xl border border-line bg-white/70 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn btn-secondary disabled:opacity-60">{saving ? "Saving…" : "Save"}</button>
        {msg && <span className={`text-xs ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</span>}
      </div>

      {(!emailReady || !whatsappReady) && (
        <p className="mt-3 text-[11px] text-ink-faint">
          {!emailReady && !whatsappReady
            ? "Delivery channels aren't switched on yet — your details are saved and reports start sending the moment they're enabled."
            : !whatsappReady
              ? "WhatsApp delivery isn't switched on yet — save your number now and it'll start sending once enabled."
              : "Email delivery isn't switched on yet — reports still live in-app and download as PDF."}
        </p>
      )}
    </section>
  );
}
