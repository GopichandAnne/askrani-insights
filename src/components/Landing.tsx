import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";

/**
 * Public front door (signed-out visitors at insights.askrani.ai). Futuristic
 * glass-on-aurora, plain-English and benefit-first — no product jargon.
 */
export function Landing() {
  return (
    <div className="animate-fade-in">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-14 lg:grid-cols-[1.05fr_0.95fr] lg:py-20">
        <div>
          <span className="glass inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold text-brand-deep">
            <span className="rani-dots scale-75" aria-hidden><span /><span /><span /></span>
            Local market intelligence, on autopilot
          </span>
          <h1 className="mt-6 font-display text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
            Know what your rivals are doing —{" "}
            <span className="text-gradient">and exactly what to do next.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-ink-soft">
            Tell us your business. We quietly watch your local competitors — their menus, prices,
            promotions and reviews — and hand you a short, clear list of moves to stay ahead. No
            spreadsheets, no guesswork.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className="btn btn-primary px-7 py-3.5 text-base">
              Get started free <RaniMark size={18} />
            </Link>
            <a href="#how" className="btn btn-secondary px-7 py-3.5 text-base">
              See how it works
            </a>
          </div>
          <p className="mt-4 text-sm text-ink-faint">Free to explore · no credit card · set up in 2 minutes</p>
        </div>

        {/* floating product-preview card */}
        <div className="relative lg:pl-6">
          <div className="animate-float glass rounded-3xl p-5 shadow-glass">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RaniMark size={30} />
                <span className="font-display text-lg font-bold italic text-brand-deep">Today</span>
              </div>
              <span className="chip bg-brand-soft text-brand-deep">live</span>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              {[["Watched", "7"], ["Events", "12"], ["Actions", "3"]].map(([l, v]) => (
                <div key={l} className="rounded-2xl bg-white/70 p-3 text-center">
                  <div className="text-2xl font-extrabold text-brand-deep">{v}</div>
                  <div className="text-[11px] text-ink-faint">{l}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-start gap-2 rounded-2xl bg-white/70 p-3 text-sm">
                <span className="chip shrink-0 bg-surface-sunken text-ink-soft">price drop</span>
                <span className="text-ink-soft"><b className="text-ink">Olio e Più</b> cut lunch combo to $12</span>
              </div>
              <div className="flex items-start gap-2 rounded-2xl bg-white/70 p-3 text-sm">
                <span className="chip shrink-0 bg-brand-soft text-brand">action</span>
                <span className="text-ink-soft">Launch a weekday lunch special this week</span>
              </div>
            </div>
          </div>
          <div className="pointer-events-none absolute -right-4 -top-6 h-24 w-24 rounded-full bg-coral/20 blur-2xl" aria-hidden />
          <div className="pointer-events-none absolute -bottom-8 left-2 h-28 w-28 rounded-full bg-brand/20 blur-2xl" aria-hidden />
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-center font-display text-3xl font-extrabold sm:text-4xl">Three steps. Two minutes.</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-ink-faint">
          Built for busy owners — no setup, no jargon, nothing to install.
        </p>
        <div className="stagger mt-10 grid gap-5 md:grid-cols-3">
          {[
            ["01", "🔎", "Find your business", "Search your name — we detect your type and pull up your neighborhood automatically."],
            ["02", "🛰️", "We watch your rivals", "We rank your closest like-for-like competitors and keep an eye on prices, dishes, offers and reviews."],
            ["03", "✅", "Get what to do", "A short, plain-English list of the smartest moves — with the proof behind each one."],
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

      {/* ── What you'll see ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-center font-display text-3xl font-extrabold sm:text-4xl">Everything about your market, in one place</h2>
        <div className="stagger mt-10 grid gap-5 sm:grid-cols-2">
          {[
            ["💸", "Their prices vs yours", "See how your menu and prices stack up against nearby competitors — instantly."],
            ["🍽️", "New dishes & promotions", "Get alerted the moment a rival launches a special, drops a price, or adds a dish."],
            ["⭐", "Reputation at a glance", "Ratings and reviews from across the web, gathered and compared in one view."],
            ["🎯", "Clear next moves", "Prioritized suggestions tailored to your business — not generic advice."],
          ].map(([icon, t, d]) => (
            <div key={t} className="card card-hover flex gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-soft text-2xl">{icon}</div>
              <div>
                <h3 className="font-bold">{t}</h3>
                <p className="mt-1 text-sm text-ink-faint">{d}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-ink-faint">
          Every insight shows exactly where it came from — so you can trust it.
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
