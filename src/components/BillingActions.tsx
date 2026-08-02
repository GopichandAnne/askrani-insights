"use client";

import { useState } from "react";

export interface BuyItem { key: string; label: string; priceUsd: number; credits: number; mode: "subscription" | "payment"; plan?: string; }

/** Buy plans / top-ups via Stripe Checkout, and manage an existing subscription. */
export function BillingActions({ plans, topups, currentPlan, hasCustomer }: { plans: BuyItem[]; topups: BuyItem[]; currentPlan: string; hasCustomer: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function checkout(key: string) {
    setBusy(key); setErr(null);
    try {
      const r = await fetch("/api/stripe/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      const d = await r.json();
      if (d.url) window.location.href = d.url; else setErr(d.error ?? "Couldn't start checkout");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function portal() {
    setBusy("portal"); setErr(null);
    try {
      const r = await fetch("/api/stripe/portal", { method: "POST" });
      const d = await r.json();
      if (d.url) window.location.href = d.url; else setErr(d.error ?? "Couldn't open billing portal");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      {err && <p className="rounded-xl border border-trust-low/30 bg-trust-low/5 p-2.5 text-sm text-trust-low">{err}</p>}

      {plans.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {plans.map((p) => {
            const current = currentPlan === p.plan;
            return (
              <div key={p.key} className={`rounded-2xl bg-white/60 p-4 ${current ? "ring-1 ring-brand/50" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{p.label}</span>
                  {current && <span className="chip bg-brand-soft text-brand-deep">current</span>}
                </div>
                <div className="mt-1 text-2xl font-extrabold text-brand-deep">${p.priceUsd}<span className="text-sm font-medium text-ink-faint">/mo</span></div>
                <div className="mt-0.5 text-xs text-ink-faint">{p.credits.toLocaleString()} credits/mo</div>
                <button onClick={() => checkout(p.key)} disabled={!!busy || current} className="btn btn-primary mt-3 w-full py-2 text-sm disabled:opacity-60">
                  {busy === p.key ? "Starting…" : current ? "Active" : "Choose"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {topups.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">One-time top-ups</div>
          <div className="flex flex-wrap gap-2">
            {topups.map((t) => (
              <button key={t.key} onClick={() => checkout(t.key)} disabled={!!busy} className="btn btn-secondary px-4 py-2 text-sm disabled:opacity-60">
                {busy === t.key ? "…" : `${t.label} · $${t.priceUsd}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {hasCustomer && (
        <button onClick={portal} disabled={!!busy} className="text-sm font-medium text-brand hover:underline disabled:opacity-60">
          {busy === "portal" ? "Opening…" : "Manage subscription / payment method →"}
        </button>
      )}
    </div>
  );
}
