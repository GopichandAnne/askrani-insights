import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";
import { ExploreClient } from "@/components/ExploreClient";

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
            <a href="#explore" className="btn btn-primary px-7 py-3.5 text-base">
              Try it free — no signup <RaniMark size={18} />
            </a>
            <Link href="/login" className="btn btn-secondary px-7 py-3.5 text-base">
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-sm text-ink-faint">Explore any area free · no credit card · monitoring runs on credits</p>
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

      {/* ── What we monitor ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-center font-display text-3xl font-extrabold sm:text-4xl">What we keep an eye on for you</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-ink-faint">
          Once you pick a business to monitor, we watch every public signal about it and its rivals — and turn it into moves.
        </p>
        <div className="stagger mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["⭐", "Ratings & reviews", "Google, Yelp and more — scores and review volume, side by side, per source."],
            ["💬", "What people really think", "Themes mined from review & social text — praise and complaints, not just stars."],
            ["📸", "Social & what's working", "Instagram, Facebook & TikTok posts — and which ones actually got engagement."],
            ["🛵", "Delivery menus & prices", "DoorDash & Uber Eats menus with real prices, promos and delivery ratings."],
            ["💸", "Menu & price comparison", "Item-by-item pricing across rivals — see exactly where you stand."],
            ["📈", "Trends, news & openings", "Industry trends, local news and new competitors opening nearby."],
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
          It&apos;s all synthesized into a plain-English <span className="font-medium text-brand-deep">weekly briefing</span>, a{" "}
          <span className="font-medium text-brand-deep">Your Edge</span> action plan, and ready-to-post drafts — every insight shows its source.
        </p>
      </section>

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
