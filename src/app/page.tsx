import Link from "next/link";
import { activeWorkspace, workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { Landing } from "@/components/Landing";
import { BriefingCard } from "@/components/BriefingCard";
import { RaniMark } from "@/components/RaniSpinner";

export const dynamic = "force-dynamic";

/**
 * Home = one command center that answers the only three questions a busy,
 * non-technical owner has: How am I doing? · What just happened? · What should I
 * do? Everything else (Feed, Offers, Competitors, Report) is a drill-down.
 */
export default async function HomePage() {
  const state = await activeWorkspace();
  if (state.status === "signedout" || state.status === "unconfigured") return <Landing />;

  return (
    <div className="animate-fade-in space-y-6">
      {state.status === "empty" ? (
        <>
          <header>
            <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
            <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Welcome</h1>
          </header>
          <SetUpCta />
        </>
      ) : (
        <Dashboard workspace={state.workspace} />
      )}
    </div>
  );
}

function SetUpCta() {
  return (
    <section className="glass-strong relative overflow-hidden rounded-3xl p-10 text-center">
      <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.1]" aria-hidden />
      <div className="relative mx-auto flex max-w-md flex-col items-center gap-4">
        <RaniMark size={52} />
        <h2 className="font-display text-2xl font-extrabold">Let&apos;s set up your business</h2>
        <p className="text-ink-soft">
          Search your business — we detect its type, find your local competitors, and gather everything about
          your market. Takes about two minutes.
        </p>
        <Link href="/onboarding" className="btn btn-primary mt-1 px-7 py-3.5 text-base">
          Get started <RaniMark size={18} />
        </Link>
      </div>
    </section>
  );
}

const KIND_META: Record<string, { icon: string; label: string; tone: string }> = {
  opening: { icon: "✨", label: "New opening", tone: "bg-coral/15 text-coral-dark" },
  trend: { icon: "📈", label: "Trend", tone: "bg-trust-corroborated/10 text-trust-corroborated" },
  local: { icon: "📰", label: "Local news", tone: "bg-surface-sunken text-ink-soft" },
  price: { icon: "💸", label: "Price move", tone: "bg-trust-inferred/10 text-trust-inferred" },
  change: { icon: "🔄", label: "Menu change", tone: "bg-brand-soft text-brand-deep" },
  reputation: { icon: "⭐", label: "Reputation", tone: "bg-trust-direct/10 text-trust-direct" },
};

async function Dashboard({ workspace }: { workspace: WorkspaceRow }) {
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(workspace);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];

  const [report, { data: news }] = await Promise.all([
    buildWorkspaceReport(workspace),
    supabase
      .from("content_item")
      .select("id,text,url,media,published_at")
      .in("business_id", scope)
      .eq("platform", "news")
      .order("published_at", { ascending: false })
      .limit(6),
  ]);

  // ── interpreted scorecard (standing, not raw counts) ──────────────────────
  const rated = report.reputation.filter((r) => r.rating != null).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const myRatingIdx = rated.findIndex((r) => r.isTarget);
  const myRating = report.reputation.find((r) => r.isTarget)?.rating ?? null;
  const best = rated[0];
  const ratingValue = myRatingIdx >= 0 ? `#${myRatingIdx + 1} of ${rated.length}` : myRating != null ? `${myRating}★` : "—";
  const ratingSub = myRating != null ? `You: ${myRating}★${best && !best.isTarget ? ` · best ${best.rating}★` : best?.isTarget ? " · you lead" : ""}` : "No rating yet";

  const myPrice = report.pricing.find((p) => p.isTarget)?.avgPrice ?? null;
  const peerPrices = report.pricing.filter((p) => !p.isTarget && p.avgPrice != null).map((p) => p.avgPrice as number);
  const areaAvg = peerPrices.length ? peerPrices.reduce((a, b) => a + b, 0) / peerPrices.length : null;
  let priceValue = "—", priceSub = "No priced items yet";
  if (myPrice != null) {
    priceValue = `$${myPrice.toFixed(0)}`;
    if (areaAvg == null) priceSub = "Avg item price";
    else { const d = ((myPrice - areaAvg) / areaAvg) * 100; priceSub = Math.abs(d) < 8 ? "About the area avg" : d > 0 ? `~${Math.round(d)}% above area` : `~${Math.round(-d)}% below area`; }
  }

  const stats = [
    { icon: "⭐", value: ratingValue, label: "Your rating rank", sub: ratingSub, href: "/reports" },
    { icon: "💸", value: priceValue, label: "Your avg price", sub: priceSub, href: "/offers" },
    { icon: "📣", value: String(report.snapshot.events30d), label: "Changes (30d)", sub: "across your market", href: "/feed" },
    { icon: "🎯", value: String(report.snapshot.openRecommendations), label: "Actions to take", sub: "recommended for you", href: "/recommendations" },
  ];

  // ── "what's new" — merge competitor changes + local news/openings/trends ──
  type Item = { key: string; kind: string; title: string; meta: string; when: number; href?: string; external?: boolean };
  const items: Item[] = [];
  for (const e of report.events.slice(0, 12)) {
    const kind = e.type.includes("price") ? "price" : e.type.includes("removed") || e.type.includes("dish") || e.type.includes("product") ? "change" : "change";
    items.push({ key: `e${e.id}`, kind, title: `${e.business} — ${e.summary}`, meta: `${Math.round(e.significance * 100)}% significance`, when: e.at ? Date.parse(e.at) : 0, href: "/feed" });
  }
  for (const n of news ?? []) {
    const kind = ((n as any).media?.[0]?.kind as string) ?? "local";
    items.push({ key: `n${(n as any).id}`, kind, title: (n as any).text, meta: (n as any).media?.[0]?.source ?? "news", when: (n as any).published_at ? Date.parse((n as any).published_at) : 0, href: (n as any).url, external: true });
  }
  items.sort((a, b) => b.when - a.when);
  const whatsNew = items.slice(0, 8);

  // ── competitor leaderboard (rating + price, you highlighted) ──────────────
  const priceByName = new Map(report.pricing.map((p) => [p.name, p.avgPrice]));
  const leaderboard = report.reputation
    .map((r) => ({ name: r.name, isTarget: r.isTarget, rating: r.rating, price: priceByName.get(r.name) ?? null }))
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 7);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
          <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{workspace.name}</h1>
        </div>
        <p className="text-sm text-ink-faint">Your market, at a glance. Press <kbd className="rounded-md bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold">⌘K</kbd> to ask anything.</p>
      </header>

      {/* 1 — briefing */}
      <BriefingCard />

      {/* 2 — scorecard */}
      <section className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="card card-hover glow-hover">
            <div className="flex items-center justify-between">
              <span className="text-xl" aria-hidden>{s.icon}</span>
            </div>
            <div className="mt-1 text-2xl font-extrabold text-brand-deep">{s.value}</div>
            <div className="text-xs font-medium text-ink">{s.label}</div>
            <div className="mt-0.5 truncate text-xs text-ink-faint">{s.sub}</div>
          </Link>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* 3 — do this now */}
        <section className="card lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🎯</span>Do this now</h2>
            <Link href="/recommendations" className="text-xs font-medium text-brand hover:underline">all →</Link>
          </div>
          {!report.recommendations.length ? (
            <p className="mt-4 text-sm text-ink-faint">No actions yet — they appear once we&apos;ve compared you to your rivals.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {report.recommendations.slice(0, 3).map((r) => (
                <li key={r.id} className="rounded-2xl bg-white/55 p-3">
                  <div className="flex items-center gap-2">
                    <span className="chip bg-brand-soft text-brand">{r.category}</span>
                    <span className="text-sm font-semibold">{r.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink-soft">{r.action}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 4 — what's new */}
        <section className="card lg:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛰️</span>What&apos;s new</h2>
            <Link href="/feed" className="text-xs font-medium text-brand hover:underline">feed →</Link>
          </div>
          {!whatsNew.length ? (
            <p className="mt-4 text-sm text-ink-faint">Nothing new yet — competitor moves, new openings and trends will show here.</p>
          ) : (
            <ul className="mt-4 space-y-1.5">
              {whatsNew.map((it) => {
                const m = KIND_META[it.kind] ?? KIND_META.local;
                const inner = (
                  <>
                    <span className={`chip shrink-0 ${m.tone}`}>{m.icon} {m.label}</span>
                    <span className="min-w-0 flex-1 text-ink-soft"><span className="text-ink">{it.title}</span></span>
                    <span className="hidden shrink-0 text-[11px] text-ink-faint sm:block">{it.meta}</span>
                  </>
                );
                return (
                  <li key={it.key} className="flex items-center gap-2 rounded-2xl bg-white/55 p-2.5 text-sm">
                    {it.external && it.href ? (
                      <a href={it.href} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80">{inner}</a>
                    ) : (
                      <Link href={it.href ?? "/feed"} className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80">{inner}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* 5 — competitors at a glance */}
      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🧭</span>Competitors at a glance</h2>
          <Link href="/competitors" className="text-xs font-medium text-brand hover:underline">manage →</Link>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-faint">
                <th className="py-1.5 font-medium">Business</th>
                <th className="py-1.5 text-right font-medium">Rating</th>
                <th className="py-1.5 text-right font-medium">Avg price</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((b, i) => (
                <tr key={i} className={`border-b border-line/60 ${b.isTarget ? "bg-brand-soft/30" : ""}`}>
                  <td className="py-2">{b.name} {b.isTarget && <span className="chip ml-1 bg-brand-soft text-brand">you</span>}</td>
                  <td className="py-2 text-right font-medium">{b.rating != null ? `${b.rating}★` : "—"}</td>
                  <td className="py-2 text-right tabular-nums text-ink-soft">{b.price != null ? `$${Number(b.price).toFixed(0)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
