/**
 * "What we monitor" — restyled as a dark monitoring console that carries the
 * hero's radar aesthetic: dark teal dial, a slow conic sweep, and each watched
 * signal a glass instrument with a live pulse dot. Pure CSS motion (no client
 * JS); reduced-motion disables the sweep. Text uses explicit light colors
 * because this sits on the dark surface, not the app's ink tokens.
 */

const SIGNALS: [string, string, string][] = [
  ["⭐", "Ratings & reviews", "Google, Yelp and more — scores and review volume, side by side, per source."],
  ["💬", "What people really think", "Themes mined from review & social text — praise and complaints, not just stars."],
  ["📸", "Social & what's working", "Instagram, Facebook & TikTok posts — and which ones actually got engagement."],
  ["💸", "Prices, packages & offers", "Treatments, services, menu items and packages — priced item-by-item across rivals."],
  ["🎁", "Promotions & specials", "Intro offers, memberships, financing and seasonal deals the moment rivals launch them."],
  ["📈", "Trends, news & openings", "Industry trends, local news and new competitors opening nearby."],
];

export function MonitorPanel() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-14">
      <div
        className="relative overflow-hidden rounded-3xl px-6 py-12 sm:px-10"
        style={{
          background: "radial-gradient(120% 120% at 50% 0%, #0a3a38 0%, #07272e 55%, #06131c 100%)",
          boxShadow: "0 30px 70px -28px rgba(6,32,31,.7), inset 0 1px 0 rgba(94,234,212,.08)",
          border: "1px solid rgba(45,212,191,.16)",
        }}
      >
        {/* faint radar rings + slow sweep behind everything */}
        <div className="pointer-events-none absolute left-1/2 top-0 -z-0 aspect-square w-[130%] max-w-[900px] -translate-x-1/2 -translate-y-1/3 opacity-70" aria-hidden>
          <div className="absolute inset-0 rounded-full" style={{ border: "1px solid rgba(94,234,212,.08)" }} />
          <div className="absolute inset-[12%] rounded-full" style={{ border: "1px solid rgba(94,234,212,.08)" }} />
          <div className="absolute inset-[26%] rounded-full" style={{ border: "1px solid rgba(94,234,212,.08)" }} />
          <div className="radar-spin absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg at 50% 50%, rgba(20,184,166,.18) 0deg, rgba(20,184,166,.04) 24deg, transparent 55deg, transparent 360deg)" }} />
        </div>

        <div className="relative">
          <div className="text-center">
            <span className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold" style={{ color: "#5eead4", background: "rgba(6,19,28,.5)", border: "1px solid rgba(94,234,212,.28)" }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#5eead4", boxShadow: "0 0 8px #5eead4" }} />
              Always-on monitoring
            </span>
            <h2 className="mt-4 font-display text-3xl font-extrabold sm:text-4xl" style={{ color: "#f0fdfa" }}>
              What Rani keeps an eye on for you
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm" style={{ color: "#9fd8cd" }}>
              Pick a business to monitor and Rani watches every public signal about it and its rivals — around the clock — turning each one into a move.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SIGNALS.map(([icon, title, desc], i) => (
              <div
                key={title}
                className="group relative rounded-2xl p-4 transition-colors"
                style={{ background: "rgba(6,20,26,.55)", border: "1px solid rgba(94,234,212,.16)" }}
              >
                {/* live pulse — staggered so signals feel like they arrive independently */}
                <span className="absolute right-3 top-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#5eead4" }}>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping" style={{ background: "#5eead4", animationDelay: `${i * 0.5}s` }} />
                    <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "#5eead4" }} />
                  </span>
                  live
                </span>
                <div className="grid h-11 w-11 place-items-center rounded-2xl text-xl" style={{ background: "linear-gradient(150deg, rgba(20,184,166,.28), rgba(20,184,166,.1))", border: "1px solid rgba(94,234,212,.3)", boxShadow: "0 0 18px -4px rgba(20,184,166,.5)" }}>
                  {icon}
                </div>
                <h3 className="mt-3 pr-10 font-bold" style={{ color: "#eafffb" }}>{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "#8fcabf" }}>{desc}</p>
              </div>
            ))}
          </div>

          {/* everything converges into the deliverables */}
          <p className="mx-auto mt-9 max-w-2xl text-center text-sm" style={{ color: "#9fd8cd" }}>
            All of it synthesized into a plain-English{" "}
            <span className="font-semibold" style={{ color: "#5eead4" }}>weekly briefing</span>, a{" "}
            <span className="font-semibold" style={{ color: "#5eead4" }}>Your Edge</span> action plan, and ready-to-post drafts — every insight shows its source.
          </p>
        </div>
      </div>
    </section>
  );
}
