import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";
import { ExploreClient } from "@/components/ExploreClient";
import { LiveRadarHero } from "@/components/LiveRadarHero";
import { MonitorPanel } from "@/components/MonitorPanel";

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

      {/* ── Pricing / credits ────────────────────────────────────────── */}
      <section id="pricing" className="mx-auto max-w-5xl px-6 py-14">
        <h2 className="text-center font-display text-3xl font-extrabold sm:text-4xl">Explore free. Monitor with credits.</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-ink-faint">
          Browsing any area is always free. When you want us to actively track a business and its rivals, that runs on credits — you only pay for what you monitor.
        </p>
        <div className="stagger mt-10 grid gap-5 md:grid-cols-2">
          <div className="card flex flex-col">
            <span className="chip w-fit bg-surface-sunken text-ink-soft">Free</span>
            <div className="mt-3 font-display text-3xl font-extrabold">$0</div>
            <p className="mt-1 text-sm text-ink-faint">No card. No signup to try.</p>
            <ul className="mt-4 space-y-2 text-sm text-ink-soft">
              {["Explore any zip or city", "Real ratings & review counts", "Ranked list + map", "A quick market overview"].map((f) => (
                <li key={f} className="flex items-start gap-2"><span className="mt-0.5 text-trust-direct" aria-hidden>✓</span>{f}</li>
              ))}
            </ul>
            <a href="#explore" className="btn btn-secondary mt-6 py-2.5">Start exploring</a>
          </div>
          <div className="card relative flex flex-col ring-1 ring-brand/40">
            <span className="chip w-fit bg-brand-gradient text-white">Monitoring · credits</span>
            <div className="mt-3 font-display text-3xl font-extrabold">Pay as you go</div>
            <p className="mt-1 text-sm text-ink-faint">Buy credits, monitor what you want. Credits scale with how much we collect per business.</p>
            <ul className="mt-4 space-y-2 text-sm text-ink-soft">
              {["Track a business + its competitors", "Prices, social, delivery menus & reviews", "Change alerts + weekly AI briefing", "Your Edge action plan + post drafts"].map((f) => (
                <li key={f} className="flex items-start gap-2"><span className="mt-0.5 text-brand" aria-hidden>✦</span>{f}</li>
              ))}
            </ul>
            <Link href="/login" className="btn btn-primary mt-6 py-2.5">Sign up to monitor <RaniMark size={16} /></Link>
          </div>
        </div>
        <p className="mx-auto mt-6 max-w-xl text-center text-xs text-ink-faint">
          Credits cover the real cost of gathering data (search, reviews, social & delivery). You control which businesses you monitor and how often.
        </p>
      </section>

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
