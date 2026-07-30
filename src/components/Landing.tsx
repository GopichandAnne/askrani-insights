import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";

/**
 * Public front door (signed-out visitors at insights.askrani.ai). Plain-English,
 * benefit-first — no product jargon. Matches the Ask Rani marketing look.
 */
export function Landing() {
  return (
    <div className="-mx-6 -my-8">
      {/* hero */}
      <section className="bg-brand-hero px-6 py-16 text-center text-white">
        <div className="mx-auto max-w-3xl">
          <span className="inline-block rounded-full bg-white/15 px-4 py-1 text-sm font-semibold">
            Local market intelligence, on autopilot
          </span>
          <h1 className="mt-6 font-display text-4xl font-extrabold leading-tight sm:text-5xl">
            Know what your competitors are doing — and exactly what to do next.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-white/90">
            Tell us your business. We quietly watch your local rivals — their menus, prices,
            promotions and reviews — and every week we hand you a short, clear list of moves to stay
            ahead. No spreadsheets, no guesswork.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/login" className="btn bg-white px-6 py-3 text-base font-semibold text-brand-deep hover:-translate-y-0.5">
              Get started free
            </Link>
            <a href="#how" className="btn border-2 border-white/50 px-6 py-3 text-base font-semibold text-white hover:bg-white/10">
              See how it works
            </a>
          </div>
          <p className="mt-4 text-sm text-white/70">Free to explore · no credit card · set up in 2 minutes</p>
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="bg-surface px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-display text-3xl font-extrabold">How it works</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              ["🔎", "Find your business", "Search your name — we pull up your listing and your neighborhood."],
              ["🤖", "We watch your rivals", "We automatically find your local competitors and keep an eye on their prices, dishes, offers and reviews."],
              ["✅", "Get what to do", "Every week: a short, plain-English list of the smartest moves — with the proof behind each one."],
            ].map(([icon, t, d]) => (
              <div key={t} className="card text-center">
                <div className="text-4xl">{icon}</div>
                <h3 className="mt-3 text-lg font-bold">{t}</h3>
                <p className="mt-2 text-sm text-ink-faint">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* what you get */}
      <section className="bg-surface-sunken px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-display text-3xl font-extrabold">What you&apos;ll see</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {[
              ["💸", "Their prices vs yours", "See how your menu and prices stack up against nearby competitors — instantly."],
              ["🍽️", "New dishes & promotions", "Get alerted the moment a rival launches a special, drops a price, or adds a dish."],
              ["⭐", "Reputation at a glance", "Reviews and ratings across the web, gathered in one place."],
              ["🎯", "Clear next moves", "Prioritized suggestions tailored to your business — not generic advice."],
            ].map(([icon, t, d]) => (
              <div key={t} className="card-hover card flex gap-4">
                <div className="text-3xl">{icon}</div>
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
        </div>
      </section>

      {/* final CTA */}
      <section className="bg-navy px-6 py-16 text-center text-white">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-4">
          <RaniMark size={44} />
          <h2 className="font-display text-3xl font-extrabold">Ready to know your market?</h2>
          <p className="text-white/70">Set up your business in about two minutes. We handle the rest.</p>
          <Link href="/login" className="btn bg-brand-gradient px-6 py-3 text-base font-semibold text-white shadow-brand hover:-translate-y-0.5">
            Get started free
          </Link>
        </div>
      </section>
    </div>
  );
}
