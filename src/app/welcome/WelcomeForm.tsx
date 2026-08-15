"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { RaniMark } from "@/components/RaniSpinner";

/**
 * The one-time details form. Saves name + business/org (and optionally an email
 * for phone-first accounts) via /api/profile/complete, which bootstraps the org,
 * grants the trial credits, and links the verified phone to the owner profile the
 * Rani WhatsApp assistant matches on. Then it continues into workspace setup.
 */
export function WelcomeForm({
  prefill,
}: {
  prefill: { name: string; business: string; email: string; phone: string };
}) {
  const router = useRouter();
  const [f, setF] = useState({ name: prefill.name, business: prefill.business, email: prefill.email });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState(""); // non-blocking heads-up (e.g. email already in use)
  const [ready, setReady] = useState(false); // profile saved; button now just navigates on

  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const inputCls = "w-full rounded-xl border border-line bg-white/80 px-3.5 py-3 text-sm outline-none focus:border-brand";

  function goOn() {
    router.push("/onboarding");
    router.refresh();
  }

  async function submit() {
    if (busy) return;
    if (ready) { goOn(); return; } // already saved — this click just proceeds
    if (!f.name.trim() || !f.business.trim()) { setErr("Please add your name and your business/organization name."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/profile/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: f.name.trim(), business_name: f.business.trim(), email: f.email.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Couldn't save your details — please try again.");
      // Profile saved. If the email couldn't be linked (already tied to another
      // account), tell them plainly and let them continue on the next click —
      // don't silently swallow it.
      if (j.emailLinked === false && f.email.trim()) {
        setReady(true);
        setNotice(`Your workspace is ready. Heads-up: ${f.email.trim()} is already linked to another account, so we couldn't add it as an email login — you'll keep signing in with your phone. It's still saved for report delivery. Tap Continue to go on.`);
        return;
      }
      goOn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-6 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <div className="glass-strong overflow-hidden rounded-3xl shadow-glass">
          <div className="relative overflow-hidden bg-brand-hero px-8 py-9 text-center text-white">
            <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl" aria-hidden />
            <div className="relative flex flex-col items-center gap-3">
              <RaniMark size={52} />
              <div>
                <div className="font-display text-2xl font-extrabold italic">Welcome to Ask Rani</div>
                <p className="mt-1 text-sm text-white/85">A couple of details and your workspace is ready.</p>
              </div>
            </div>
          </div>

          <div className="space-y-3 p-7">
            <label className="block text-xs font-semibold text-ink-soft">Your name
              <input value={f.name} onChange={set("name")} placeholder="Your name" className={`${inputCls} mt-1`} />
            </label>
            <label className="block text-xs font-semibold text-ink-soft">Business / organization
              <input value={f.business} onChange={set("business")} placeholder="Business / organization name" className={`${inputCls} mt-1`} />
            </label>
            <label className="block text-xs font-semibold text-ink-soft">Email {prefill.email ? "" : "(optional)"}
              <input value={f.email} onChange={set("email")} type="email" placeholder="you@business.com" className={`${inputCls} mt-1`} />
            </label>

            {prefill.phone && (
              <div className="flex items-center gap-2 rounded-xl bg-surface-sunken px-3.5 py-2.5 text-sm text-ink-soft">
                <span aria-hidden>📱</span>
                <span>Signed in as <b className="text-ink">{prefill.phone}</b></span>
                <span className="ml-auto text-[11px] font-semibold text-trust-direct">verified</span>
              </div>
            )}

            {notice && (
              <p className="rounded-xl border border-brand/25 bg-brand-soft/60 p-2.5 text-sm text-ink-soft">{notice}</p>
            )}

            <button onClick={submit} disabled={busy} className="btn btn-primary w-full py-3 disabled:opacity-60">
              {busy ? "Setting up…" : "Continue →"}
            </button>
            {!ready && (
              <p className="text-center text-[11px] text-ink-faint">We use your business name for your workspace, and your number so Rani recognizes you on WhatsApp.</p>
            )}

            {err && (
              <p className="rounded-xl border border-trust-low/30 bg-trust-low/5 p-2.5 text-sm text-trust-low">{err}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
