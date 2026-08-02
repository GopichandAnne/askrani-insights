import Link from "next/link";
import { getUser } from "@/lib/auth";
import { requireOrg } from "@/lib/api";
import { creditsSummary, CREDIT_COGS_CAP_USD, PLANS, getStripeCustomer } from "@/lib/credits";
import { isStripeConfigured, CATALOG } from "@/lib/stripe";
import { BillingActions, type BuyItem } from "@/components/BillingActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing & credits — Ask Rani Insights" };

const REASON_LABEL: Record<string, string> = {
  trial_grant: "Trial credits", plan_grant: "Plan credits", period_reset: "Monthly reset",
  topup_purchase: "Top-up", collection_debit: "Monitoring", ai_debit: "AI analysis", adjustment: "Adjustment", refund: "Refund",
};

export default async function BillingPage() {
  const user = await getUser();
  if (!user) return <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">Sign in to see your credits.</p>;
  const auth = await requireOrg();
  if (!auth) return <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">No organization found.</p>;

  const s = await creditsSummary(auth.orgId);
  // a "business refresh" ≈ 5 credits (avg full collection ≈ $0.10 at $0.02/credit)
  const refreshes = Math.floor(s.balance / 5);
  const stripeReady = isStripeConfigured();
  const hasCustomer = stripeReady ? !!(await getStripeCustomer(auth.orgId)) : false;
  const toItem = (k: string): BuyItem => ({ key: k, label: CATALOG[k].label, priceUsd: CATALOG[k].priceUsd, credits: CATALOG[k].credits, mode: CATALOG[k].mode, plan: CATALOG[k].plan });
  const buyPlans = stripeReady ? ["starter", "growth", "pro"].filter((k) => CATALOG[k].price).map(toItem) : [];
  const buyTopups = stripeReady ? ["topup_500", "topup_1500", "topup_5000"].filter((k) => CATALOG[k].price).map(toItem) : [];

  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Billing &amp; credits</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">Exploring is always free. Monitoring runs on credits — here&apos;s your balance and usage.</p>
      </header>

      {/* balance */}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="glass-strong rounded-3xl p-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Credits available</div>
          <div className="mt-1 font-display text-4xl font-extrabold text-brand-deep">{s.balance.toLocaleString()}</div>
          <div className="mt-1 text-sm text-ink-faint">≈ {refreshes.toLocaleString()} business refreshes left</div>
        </div>
        <div className="card">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Used so far</div>
          <div className="mt-1 text-2xl font-extrabold">{s.totalSpent.toLocaleString()}</div>
          <div className="mt-0.5 text-xs text-ink-faint">credits spent monitoring</div>
        </div>
        <div className="card">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Includes</div>
          <div className="mt-1 text-2xl font-extrabold">{s.trialGranted ? "Trial" : "—"}</div>
          <div className="mt-0.5 text-xs text-ink-faint">free credits to start</div>
        </div>
      </section>

      {/* buy plans / top-ups */}
      <section className="card">
        <div className="mb-3">
          <h2 className="font-semibold">Plans &amp; top-ups</h2>
          <p className="text-sm text-ink-faint">
            You&apos;re on the <span className="font-medium text-brand-deep">{PLANS[s.plan]?.label ?? s.plan}</span> plan{s.status !== "active" ? ` (${s.status})` : ""}. Pick a plan for ongoing credits, or top up any time.
          </p>
        </div>
        {stripeReady && (buyPlans.length > 0 || buyTopups.length > 0) ? (
          <BillingActions plans={buyPlans} topups={buyTopups} currentPlan={s.plan} hasCustomer={hasCustomer} />
        ) : (
          <>
            <p className="text-sm text-ink-faint">Checkout isn&apos;t switched on yet. For now, explore is free and your trial credits cover monitoring.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {(["starter", "growth", "pro"] as const).map((k) => {
                const p = PLANS[k];
                return (
                  <div key={k} className="rounded-2xl bg-white/55 p-3.5">
                    <div className="font-semibold">{p.label}</div>
                    <div className="text-2xl font-extrabold text-brand-deep">${p.priceUsd}<span className="text-sm font-medium text-ink-faint">/mo</span></div>
                    <div className="mt-1 text-xs text-ink-faint">{p.monthlyCredits.toLocaleString()} credits · up to {p.businessCap} businesses · {p.cadence}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* usage */}
      <section className="card">
        <h2 className="font-semibold">Recent usage</h2>
        {s.recent.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">No monitoring yet — <Link href="/onboarding" className="text-brand hover:underline">set up a business</Link> to start.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line/50 text-sm">
            {s.recent.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{REASON_LABEL[e.reason] ?? e.reason}</span>
                  <span className="ml-2 text-xs text-ink-faint">{new Date(e.ts).toLocaleString()}{e.costUsd ? ` · $${e.costUsd.toFixed(3)} cost` : ""}</span>
                </span>
                <span className={`shrink-0 font-semibold tabular-nums ${e.delta >= 0 ? "text-trust-direct" : "text-ink"}`}>{e.delta >= 0 ? "+" : ""}{e.delta}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-ink-faint">1 credit covers up to ${CREDIT_COGS_CAP_USD.toFixed(2)} of data-collection cost. Exploring areas is free and never uses credits.</p>
      </section>
    </div>
  );
}
