import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";

/**
 * Pricing — carries the radar aesthetic onto a dark console. Rather than a
 * second spinning sweep (the monitor panel already owns that), the recommended
 * plan gets a radar "target-lock": concentric rings + glow breathing behind it,
 * as if Rani has locked onto the choice. Free plan is calm dark glass. Light
 * colors are explicit because this sits on the dark surface.
 */

const FREE = ["Explore any zip or city", "Real ratings & review counts", "Ranked list + map", "A quick market overview"];
const PAID = ["Track a business — or a whole area, no business needed", "Prices, social, delivery menus & reviews", "Change alerts + weekly AI briefing", "Your Edge / the opening + post drafts"];

export function PricingPanel() {
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-6 py-14">
      <div
        className="relative overflow-hidden rounded-3xl px-6 py-12 sm:px-10"
        style={{
          background: "radial-gradient(120% 120% at 50% 0%, #0a3a38 0%, #07272e 55%, #06131c 100%)",
          boxShadow: "0 30px 70px -28px rgba(6,32,31,.7), inset 0 1px 0 rgba(94,234,212,.08)",
          border: "1px solid rgba(45,212,191,.16)",
        }}
      >
        <div className="relative text-center">
          <span className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold" style={{ color: "#5eead4", background: "rgba(6,19,28,.5)", border: "1px solid rgba(94,234,212,.28)" }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#5eead4", boxShadow: "0 0 8px #5eead4" }} />
            Simple pricing
          </span>
          <h2 className="mt-4 font-display text-3xl font-extrabold sm:text-4xl" style={{ color: "#f0fdfa" }}>Explore free. Monitor with credits.</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm" style={{ color: "#9fd8cd" }}>
            Browsing any area is always free. When you want Rani to actively track a business and its rivals, that runs on credits — you only pay for what you monitor.
          </p>
        </div>

        <div className="relative mt-10 grid gap-5 md:grid-cols-2">
          {/* Free — calm dark glass */}
          <div className="flex flex-col rounded-2xl p-6" style={{ background: "rgba(6,20,26,.5)", border: "1px solid rgba(94,234,212,.14)" }}>
            <span className="w-fit rounded-full px-3 py-1 text-xs font-semibold" style={{ color: "#9fd8cd", background: "rgba(255,255,255,.06)", border: "1px solid rgba(148,163,184,.25)" }}>Free</span>
            <div className="mt-3 font-display text-3xl font-extrabold" style={{ color: "#f0fdfa" }}>$0</div>
            <p className="mt-1 text-sm" style={{ color: "#8fcabf" }}>No card. No signup to try.</p>
            <ul className="mt-4 space-y-2 text-sm" style={{ color: "#c9e9e1" }}>
              {FREE.map((f) => (
                <li key={f} className="flex items-start gap-2"><span className="mt-0.5" style={{ color: "#5eead4" }} aria-hidden>✓</span>{f}</li>
              ))}
            </ul>
            <a href="#explore" className="mt-6 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-bold transition-colors" style={{ color: "#5eead4", border: "1px solid rgba(94,234,212,.45)" }}>
              Start exploring
            </a>
          </div>

          {/* Monitoring — radar target-lock */}
          <div className="relative">
            {/* lock rings + glow behind the card */}
            <div className="pointer-events-none absolute left-1/2 top-1/2 -z-0 aspect-square w-[122%] -translate-x-1/2 -translate-y-1/2" aria-hidden>
              <div className="radar-lock absolute inset-0 rounded-full" style={{ border: "1px solid rgba(94,234,212,.25)" }} />
              <div className="radar-lock absolute inset-[10%] rounded-full" style={{ border: "1px solid rgba(94,234,212,.18)", animationDelay: ".6s" }} />
              <div className="absolute inset-[22%] rounded-full" style={{ background: "radial-gradient(circle, rgba(20,184,166,.28), transparent 70%)", filter: "blur(14px)" }} />
            </div>

            <div className="relative flex h-full flex-col rounded-2xl p-6" style={{ background: "rgba(8,28,30,.72)", border: "1px solid rgba(94,234,212,.42)", boxShadow: "0 0 34px -8px rgba(20,184,166,.6)" }}>
              <div className="flex items-center justify-between">
                <span className="w-fit rounded-full px-3 py-1 text-xs font-bold text-teal-950" style={{ background: "linear-gradient(140deg,#5eead4,#14b8a6)" }}>Monitoring · credits</span>
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide" style={{ color: "#5eead4" }}>
                  <span className="inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" style={{ background: "#5eead4", boxShadow: "0 0 8px #5eead4" }} /> locked on
                </span>
              </div>
              <div className="mt-3 font-display text-3xl font-extrabold" style={{ color: "#f0fdfa" }}>Pay as you go</div>
              <p className="mt-1 text-sm" style={{ color: "#8fcabf" }}>Buy credits, monitor what you want. Credits scale with how much we collect per business.</p>
              <ul className="mt-4 space-y-2 text-sm" style={{ color: "#eafffb" }}>
                {PAID.map((f) => (
                  <li key={f} className="flex items-start gap-2"><span className="mt-0.5" style={{ color: "#5eead4" }} aria-hidden>✦</span>{f}</li>
                ))}
              </ul>
              <Link href="/login" className="mt-6 inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold text-teal-950 transition-transform hover:scale-[1.02]" style={{ background: "linear-gradient(140deg,#5eead4,#14b8a6)", boxShadow: "0 10px 24px -8px rgba(20,184,166,.7)" }}>
                Sign up to monitor <RaniMark size={16} />
              </Link>
            </div>
          </div>
        </div>

        <p className="relative mx-auto mt-6 max-w-xl text-center text-xs" style={{ color: "#8fcabf" }}>
          Credits cover the real cost of gathering data (search, reviews, social &amp; delivery). You control which businesses you monitor and how often.
        </p>
      </div>
    </section>
  );
}
