"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { VERTICALS, verticalLabel, verticalEmoji } from "@/lib/classify";

/**
 * "Business type" settings — lets the owner correct the auto-detected vertical in
 * place (drives vocab, keyword generation, festival fit). Saves via
 * /api/workspace/vertical and refreshes; does not re-discover competitors.
 */
export function BusinessTypeCard({ current }: { current: string }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = value !== current;

  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/workspace/vertical", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vertical: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setMsg({ ok: true, text: "Saved." }); router.refresh(); }
      else setMsg({ ok: false, text: d.error === "invalid_vertical" ? "Pick a valid type." : "Couldn't save — try again." });
    } catch {
      setMsg({ ok: false, text: "Couldn't save — try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="font-semibold">Business type</h2>
      <p className="mt-0.5 text-sm text-ink-faint">Rani detects this automatically. If it&apos;s off, fix it here — it shapes your keywords, vocabulary and which festivals we plan for.</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-10 rounded-xl border border-line bg-surface px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        >
          {VERTICALS.map((v) => (
            <option key={v} value={v}>{verticalEmoji(v)} {verticalLabel(v)}</option>
          ))}
        </select>
        <button onClick={save} disabled={saving || !dirty} className="btn btn-primary px-5 py-2 text-sm disabled:opacity-50">
          {saving ? "Saving…" : "Save type"}
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</span>}
      </div>

      <p className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-[11px] text-ink-faint">
        Changing the type doesn&apos;t re-pick your competitors — it updates how Rani reads and plans for you going forward.
      </p>
    </section>
  );
}
