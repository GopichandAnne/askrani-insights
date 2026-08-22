"use client";

import { useState } from "react";

/**
 * "Your details" — lets the owner keep their name and contact phone current. The
 * phone is saved to the owner profile so it's ready to power WhatsApp when that's
 * switched on; nothing is sent over WhatsApp today. Email is shown read-only (it's
 * the sign-in identity; changing it needs a verification step we don't do here).
 */
export function ProfileCard({ initial }: { initial: { full_name: string; phone: string; email: string } }) {
  const [name, setName] = useState(initial.full_name);
  const [phone, setPhone] = useState(initial.phone);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = name.trim() !== initial.full_name.trim() || phone.trim() !== initial.phone.trim();

  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/profile/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: name, phone }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setPhone(d.ownerProfile?.phone ?? phone);
        setMsg({ ok: true, text: "Saved." });
      } else {
        setMsg({ ok: false, text: d.error ?? "Couldn't save — try again." });
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't save — try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="font-semibold">Your details</h2>
      <p className="mt-0.5 text-sm text-ink-faint">Keep your contact info current — it&apos;s how we&apos;ll reach you.</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Priya Sharma"
            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Phone number</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 512 555 0142"
            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm tabular-nums outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <span className="mt-1 block text-[11px] text-ink-faint">Include your country code (e.g. +1). Leave blank to remove it.</span>
        </label>
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Email</span>
        <div className="flex items-center gap-2 text-sm text-ink-soft">
          <span className="truncate">{initial.email || "—"}</span>
          <span className="chip bg-surface-sunken text-ink-faint">sign-in</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={saving || !dirty} className="btn btn-primary px-5 py-2 text-sm disabled:opacity-50">
          {saving ? "Saving…" : "Save details"}
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</span>}
      </div>

      <p className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-[11px] text-ink-faint">
        📱 We save your number so we can reach you on WhatsApp once it&apos;s available — we don&apos;t send any WhatsApp messages yet.
      </p>
    </section>
  );
}
