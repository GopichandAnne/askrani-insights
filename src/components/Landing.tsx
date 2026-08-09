import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";
import { ExploreClient } from "@/components/ExploreClient";
import { LiveRadarHero } from "@/components/LiveRadarHero";
import { MonitorPanel } from "@/components/MonitorPanel";
import { PricingPanel } from "@/components/PricingPanel";

/**
 * Public front door (signed-out visitors at insights.askrani.ai). Futuristic
 * glass-on-aurora, plain-English and benefit-first — no product jargon.
 */
export function Landing() {
  return (
    <div className="animate-fade-in">
      {/* ── Hero: live market-radar (the product doing its job on load) ── */}
      <LiveRadarHero />

      {/* ── Try it now: live Explore (no signup) ─────────────────────── */}
      <section id="explore" className="mx-auto max-w-5xl px-6 py-14">
        <div className="mb-6 text-center">
          <span className="chip bg-brand-soft text-brand-deep">Free · no signup</span>
          <h2 className="mt-3 font-display text-3xl font-extrabold sm:text-4xl">See who&apos;s competing in your area</h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-faint">
            Type a zip or city and what you&apos;re after — get the real businesses there, ranked by rating, on a map. Try it right now.
          </p>
        </div>
        <ExploreClient signedOut />
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-center font-display text-3xl font-extrabold sm:text-4xl">From zero to your first plan in two minutes</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-ink-faint">
          No jargon, nothing to install — and you can try step one right now, free.
        </p>
        <div className="stagger mt-10 grid gap-5 md:grid-cols-3">
          {[
            ["01", "🔎", "Explore your area", "Search any zip or city and see who's around, ranked by rating. Free, no signup."],
            ["02", "📍", "Pick your business", "Choose your spot — we auto-find your closest real competitors so you don't have to."],
            ["03", "🛰️", "Rani watches & advises", "We track prices, offers, reviews and social — and hand you a weekly plan of what to do."],
          ].map(([n, icon, t, d]) => (
            <div key={t} className="card card-hover">
              <div className="flex items-center justify-between">
                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-gradient text-xl shadow-brand">{icon}</div>
                <span className="font-display text-3xl font-extrabold text-brand/25">{n}</span>
              </div>
              <h3 className="mt-4 text-lg font-bold">{t}</h3>
              <p className="mt-2 text-sm text-ink-faint">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── What you get (outcomes) ──────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-center font-display text-3xl font-extrabold sm:text-4xl">What you get out of it</h2>
        <div className="stagger mt-10 grid gap-5 sm:grid-cols-2">
          {[
            ["📊", "Know exactly where you rank", "Your rating, price and standing versus every nearby rival — at a glance."],
            ["🔔", "Never miss a competitor move", "Get flagged when a rival drops a price, launches a promo, or posts a hit."],
            ["🎯", "Get told what to do", "A short, prioritized list of the smartest moves — with the proof behind each."],
            ["✍️", "Act in one click", "Turn any suggestion into a ready-to-post caption, sign or SMS blast."],
          ].map(([icon, t, d]) => (
            <div key={t} className="card card-hover flex gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-gradient text-2xl shadow-brand">{icon}</div>
              <div>
                <h3 className="font-bold">{t}</h3>
                <p className="mt-1 text-sm text-ink-faint">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── What we monitor: dark radar-console (carries the hero aesthetic) ── */}
      <MonitorPanel />

      {/* ── Pricing: radar target-lock console (carries the aesthetic) ── */}
      <PricingPanel />

      {/* ── Final CTA ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 pb-20 pt-6">
        <div className="glass-strong relative overflow-hidden rounded-3xl px-6 py-14 text-center">
          <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.12]" aria-hidden />
          <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-4">
            <RaniMark size={52} />
            <h2 className="font-display text-3xl font-extrabold sm:text-4xl">Ready to know your market?</h2>
            <p className="text-ink-soft">Set up your business in about two minutes. We handle the rest.</p>
            <Link href="/login" className="btn btn-primary mt-2 px-8 py-3.5 text-base">
              Get started free <RaniMark size={18} />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
