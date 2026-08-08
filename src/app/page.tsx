import Link from "next/link";
import { activeWorkspace, workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { Landing } from "@/components/Landing";
import { BriefingCard } from "@/components/BriefingCard";
import { EdgeThisWeek } from "@/components/EdgeThisWeek";
import { DraftButton } from "@/components/DraftButton";
import { DigestFeed } from "@/components/DigestFeed";
import { buildDigest } from "@/lib/digest";
import { RaniMark } from "@/components/RaniSpinner";
import { creditsSummary, PLANS } from "@/lib/credits";

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
  price: { icon: "💸", label: "Price change", tone: "bg-trust-inferred/10 text-trust-inferred" },
  promo: { icon: "🏷️", label: "New promo", tone: "bg-coral/15 text-coral-dark" },
  new_item: { icon: "🆕", label: "New items", tone: "bg-brand-soft text-brand-deep" },
  removed: { icon: "➖", label: "Removed", tone: "bg-surface-sunken text-ink-soft" },
  reputation: { icon: "⭐", label: "Reputation", tone: "bg-trust-direct/10 text-trust-direct" },
  // competitor social posts (their offers live here)
  social_promo: { icon: "🏷️", label: "Competitor deal", tone: "bg-coral/15 text-coral-dark" },
  instagram: { icon: "📸", label: "Instagram", tone: "bg-brand-soft text-brand-deep" },
  facebook: { icon: "👍", label: "Facebook", tone: "bg-brand-soft text-brand-deep" },
  tiktok: { icon: "🎵", label: "TikTok", tone: "bg-surface-sunken text-ink-soft" },
  youtube: { icon: "▶️", label: "YouTube", tone: "bg-surface-sunken text-ink-soft" },
};
// compact number: 8300 -> "8.3k"
const fmtN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));
// caption keywords that mark a social post as an actual offer/promo
const PROMO_RE = /\b(sale|deal|deals|offer|discount|%|\$\d|special|weekend|combo|bogo|buy one|save|saving|clearance|promo|coupon|off\b)/i;
const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube" };
// plural nouns used when we roll many same-type events into one summary row
const BUCKET_NOUN: Record<string, string> = {
  price: "price changes", promo: "new promotions", new_item: "new items", removed: "items removed", reputation: "rating updates",
};
function eventBucket(t: string): string {
  if (t.includes("price")) return "price";
  if (t.includes("sale") || t.includes("promo") || t.includes("combo") || t.includes("happy")) return "promo";
  if (t.includes("removed")) return "removed";
  if (t.includes("rating") || t.includes("review")) return "reputation";
  return "new_item";
}

// Evergreen starter actions to fill "Do this now" when there aren't enough
// data-driven recommendations yet — plain, non-tech, high-leverage.
const QUICK_WINS: Record<string, { category: string; title: string; action: string }[]> = {
  restaurant: [
    { category: "reviews", title: "Ask for a few reviews", action: "Ask 5 happy diners this week to leave a Google review — it's the fastest way to climb the local ranking." },
    { category: "menu", title: "Put your prices online", action: "Make sure your full menu with prices is on your website and Google — it's the first thing new diners check." },
    { category: "promotion", title: "Run a weekday special", action: "Post one clearly-priced special (e.g. a lunch combo) on Instagram to fill slow days." },
  ],
  grocery: [
    { category: "reviews", title: "Ask for a few reviews", action: "Ask happy shoppers to leave a Google review — ratings decide who finds your store first." },
    { category: "content", title: "Post this week's deals", action: "Share your weekly deals on Instagram/Facebook — the top-rated grocers nearby post several times a week." },
    { category: "menu", title: "List your staples online", action: "Put popular items and prices online so shoppers can compare before they drive over." },
  ],
  salon: [
    { category: "reviews", title: "Turn happy clients into reviews", action: "Text your 5 most recent 5-star clients a direct Google review link — reviews are the #1 driver of new bookings for med spas." },
    { category: "content", title: "Post real before & afters", action: "Share consented before/after results on Instagram + TikTok — it's what converts followers into consults. Top spas nearby post 3–5×/week." },
    { category: "promotion", title: "Feature one signature treatment", action: "Put a clearly-priced hero offer (e.g. a Botox or facial intro) on your site and Google so new clients can book without calling." },
  ],
};

const HEALTH_TEASE: Record<string, { icon: string; label: string }> = {
  strong: { icon: "💪", label: "Strong" }, watch: { icon: "👀", label: "Worth watching" }, at_risk: { icon: "⚠️", label: "Needs attention" },
};

/** A compact "peek" card that links to one of the deeper surfaces. */
function Tease({ href, icon, eyebrow, text }: { href: string; icon: string; eyebrow: string; text: string }) {
  return (
    <Link href={href} className="card card-hover glow-hover block">
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand" aria-hidden>{icon}</span>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">{eyebrow}</div>
          <p className="mt-0.5 line-clamp-2 text-sm text-ink-soft">{text}</p>
        </div>
      </div>
    </Link>
  );
}

async function Dashboard({ workspace }: { workspace: WorkspaceRow }) {
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(workspace);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];

  // org credits/plan for the dashboard strip (+ cached local trends for the tease)
  const { data: wsOrg } = await supabase.from("workspace").select("organization_id, goals").eq("id", workspace.id).maybeSingle();
  const credits = wsOrg?.organization_id ? await creditsSummary(wsOrg.organization_id as string) : null;
  // Read the CACHED syntheses only (never generate here — keeps the home fast).
  const goals = (wsOrg?.goals as Record<string, any> | null) ?? {};
  const topTrends = ((goals.localTrends?.trends as { topic: string; momentum: string }[] | undefined) ?? []).slice(0, 3);
  const youSyn = goals.you?.synthesis as { health?: string; headline?: string } | undefined;
  const winList = (goals.winning?.winning as { name: string; onYourMenu: boolean; signal?: string }[] | undefined) ?? [];
  const topGap = winList.find((w) => !w.onYourMenu) ?? winList[0];
  const topSwipe = goals.content?.swipe?.[0] as { format?: string; yourVersion?: string } | undefined;
  const industryBest = goals.industryBest?.best?.[0] as { format?: string; yourVersion?: string } | undefined;
  // The digest — "what changed & what to do," built from the cached pillars (pure,
  // no I/O). Same content that gets pushed to the owner's inbox each week.
  const digest = buildDigest({ name: workspace.name, vertical: workspace.vertical }, goals, (goals.digestSeen?.ids as string[]) ?? []);

  const [report, { data: news }, { data: social }] = await Promise.all([
    buildWorkspaceReport(workspace),
    supabase
      .from("content_item")
      .select("id,text,url,media,published_at")
      .in("business_id", scope)
      .eq("platform", "news")
      .order("published_at", { ascending: false })
      .limit(6),
    supabase
      .from("content_item")
      .select("id,text,url,platform,media,published_at,observed_at,business:business_id(canonical_name)")
      .in("business_id", scope)
      .in("platform", ["instagram", "facebook", "tiktok", "youtube"])
      .order("observed_at", { ascending: false })
      .limit(80),
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

  // ── "what's new" — GROUP many similar competitor events into one summary
  //    ("H Mart — 24 new items") so it stays glanceable, then merge with local
  //    news/openings/trends. Grouping also tames noisy bulk menu imports.
  type Item = { key: string; kind: string; title: string; meta: string; when: number; href?: string; external?: boolean };
  const groups = new Map<string, { business: string; bucket: string; count: number; sample: string; when: number; sig: number }>();
  for (const e of report.events) {
    const bucket = eventBucket(e.type);
    const key = `${e.business}|${bucket}`;
    const g = groups.get(key) ?? { business: e.business, bucket, count: 0, sample: e.summary, when: 0, sig: 0 };
    g.count++;
    g.when = Math.max(g.when, e.at ? Date.parse(e.at) : 0);
    g.sig = Math.max(g.sig, e.significance);
    groups.set(key, g);
  }
  const items: Item[] = [];
  for (const g of groups.values()) {
    const many = g.count >= 3;
    items.push({
      key: `g${g.business}${g.bucket}`,
      kind: g.bucket,
      title: many ? `${g.business} — ${g.count} ${BUCKET_NOUN[g.bucket] ?? "updates"}` : `${g.business} — ${g.sample}`,
      meta: many ? `${g.count} updates` : `${Math.round(g.sig * 100)}% significance`,
      when: g.when,
      href: "/feed",
    });
  }
  for (const n of news ?? []) {
    const kind = ((n as any).media?.[0]?.kind as string) ?? "local";
    items.push({ key: `n${(n as any).id}`, kind, title: (n as any).text, meta: (n as any).media?.[0]?.source ?? "news", when: (n as any).published_at ? Date.parse((n as any).published_at) : 0, href: (n as any).url, external: true });
  }
  // competitor SOCIAL posts — their actual offers live in the captions. Prefer
  // promo-like posts, then most recent; keep 2 per business so it stays diverse.
  const socialRanked = (social ?? [])
    .map((s) => {
      const cap = String((s as any).text || "").replace(/\s+/g, " ").trim();
      const when = (s as any).published_at ? Date.parse((s as any).published_at) : (s as any).observed_at ? Date.parse((s as any).observed_at) : 0;
      return { s, cap, promo: PROMO_RE.test(cap), when };
    })
    .filter((x) => x.cap.length > 4)
    .sort((a, b) => Number(b.promo) - Number(a.promo) || b.when - a.when);
  const perBiz = new Map<string, number>();
  for (const x of socialRanked) {
    const biz = (x.s as any).business?.canonical_name ?? "A competitor";
    const n = perBiz.get(biz) ?? 0;
    if (n >= 2) continue;
    perBiz.set(biz, n + 1);
    const plat = (x.s as any).platform as string;
    const mm = (Array.isArray((x.s as any).media) ? (x.s as any).media.find((m: any) => m?.type === "metrics") : null) as any;
    const eng = mm ? [mm.views != null ? `👁 ${fmtN(mm.views)}` : "", mm.likes != null ? `❤️ ${fmtN(mm.likes)}` : ""].filter(Boolean).join(" ") : "";
    items.push({
      key: `s${(x.s as any).id}`,
      kind: x.promo ? "social_promo" : plat,
      title: `${biz} — ${x.cap.slice(0, 96)}${x.cap.length > 96 ? "…" : ""}`,
      meta: eng || (x.promo ? PLATFORM_LABEL[plat] ?? "Social" : "posted"),
      when: x.when,
      href: (x.s as any).url,
      external: true,
    });
  }
  items.sort((a, b) => b.when - a.when);
  // Split "what's new" the way an owner thinks about it: their competitors vs
  // what's happening around them (local news / openings / industry trends).
  const AROUND = new Set(["opening", "trend", "local"]);
  const competitorItems = items.filter((it) => !AROUND.has(it.kind)).slice(0, 8);
  const aroundItems = items.filter((it) => AROUND.has(it.kind)).slice(0, 5);

  const renderRow = (it: Item) => {
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
  };

  // ── do-this-now: real recommendations, topped up with evergreen quick wins ──
  const wins = QUICK_WINS[workspace.vertical] ?? QUICK_WINS.restaurant;
  const actions: { category: string; title: string; action: string; tip?: boolean }[] = report.recommendations.slice(0, 3).map((r) => ({ category: r.category, title: r.title, action: r.action }));
  for (const w of wins) {
    if (actions.length >= 3) break;
    if (actions.some((a) => a.category === w.category)) continue;
    actions.push({ ...w, tip: true });
  }

  // ── competitor leaderboard (rating + price, you highlighted) ──────────────
  const priceByName = new Map(report.pricing.map((p) => [p.name, p.avgPrice]));
  const leaderboard = report.reputation
    .map((r) => ({ name: r.name, isTarget: r.isTarget, rating: r.rating, sources: r.sources, price: priceByName.get(r.name) ?? null }))
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 7);
  const SRC_ABBR: Record<string, string> = { google: "G", yelp: "Y", facebook: "FB", tripadvisor: "TA", trustpilot: "TP" };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
          <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{workspace.name}</h1>
        </div>
        <p className="text-sm text-ink-faint">Your market, at a glance. Press <kbd className="rounded-md bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold">⌘K</kbd> to ask anything.</p>
      </header>

      {/* 0 — monitoring & credits strip */}
      <section className="glass flex flex-wrap items-center justify-between gap-x-8 gap-y-3 rounded-2xl px-5 py-3.5">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <div className="text-xl font-extrabold text-brand-deep">{ids.all.length}</div>
            <div className="text-xs text-ink-faint">Businesses monitored{ids.competitorIds.length ? ` · ${ids.competitorIds.length} rivals` : ""}</div>
          </div>
          <div>
            <div className="text-xl font-extrabold text-brand-deep">{credits ? credits.balance.toLocaleString() : "—"}</div>
            <div className="text-xs text-ink-faint">Credits left{credits ? ` · ≈ ${Math.floor(credits.balance / 5)} refreshes` : ""}</div>
          </div>
          <div>
            <div className="text-xl font-extrabold text-brand-deep">{PLANS[credits?.plan ?? "free"]?.label ?? "Free"}</div>
            <div className="text-xs text-ink-faint">Current plan</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/explore" className="btn btn-secondary px-3 py-1.5 text-sm">🔎 Explore an area</Link>
          <Link href="/onboarding" className="btn btn-secondary px-3 py-1.5 text-sm">+ Add business</Link>
          <Link href="/billing" className="btn btn-primary px-3 py-1.5 text-sm">Buy credits</Link>
        </div>
      </section>

      {/* 1 — This Week: what needs you (digest), then the briefing + edge synthesis */}
      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">This week</p>
        <DigestFeed digest={digest} />
        <BriefingCard />
        <EdgeThisWeek />
        {topTrends.length > 0 && (
          <Link href="/around" className="card card-hover glow-hover block">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-brand" aria-hidden>🔥</span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Trending near you</div>
                <p className="truncate text-sm text-ink-soft">{topTrends.map((t) => t.topic).join("  ·  ")}</p>
              </div>
              <span className="shrink-0 text-xs font-medium text-brand">See all →</span>
            </div>
          </Link>
        )}

        {/* peeks into the deeper lenses — from cached syntheses (no generation) */}
        {(youSyn?.headline || topGap || topSwipe?.format || industryBest?.format) && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {youSyn?.headline && (
              <Tease
                href="/you"
                icon={HEALTH_TEASE[youSyn.health ?? "watch"]?.icon ?? "🙂"}
                eyebrow={`How you're doing${youSyn.health ? ` · ${HEALTH_TEASE[youSyn.health]?.label ?? ""}` : ""}`}
                text={youSyn.headline}
              />
            )}
            {topGap && (
              <Tease
                href="/winning"
                icon="🏆"
                eyebrow={topGap.onYourMenu ? "What's winning · yours" : "What's winning · gap to grab"}
                text={topGap.signal ? `${topGap.name} — ${topGap.signal}` : topGap.name}
              />
            )}
            {(topSwipe?.format || industryBest?.format) && (
              <Tease
                href="/content"
                icon={topSwipe?.format ? "🎬" : "🌎"}
                eyebrow={topSwipe?.format ? "Content idea" : "Trending in your industry"}
                text={(topSwipe?.yourVersion || topSwipe?.format || industryBest?.yourVersion || industryBest?.format) as string}
              />
            )}
          </div>
        )}
      </div>

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

      {/* 3 — do this now (full width; recs topped up with quick wins) */}
      <section className="card">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🎯</span>Do this now</h2>
          <Link href="/recommendations" className="text-xs font-medium text-brand hover:underline">all →</Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {actions.map((a, i) => (
            <div key={i} className="flex flex-col rounded-2xl bg-white/55 p-3.5">
              <div className="flex items-center gap-2">
                <span className={`chip ${a.tip ? "bg-surface-sunken text-ink-soft" : "bg-brand-soft text-brand"}`}>{a.tip ? "quick win" : a.category}</span>
                <span className="text-sm font-semibold">{a.title}</span>
              </div>
              <p className="mt-1 flex-1 text-sm text-ink-soft">{a.action}</p>
              <DraftButton move={`${a.title}: ${a.action}`} />
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* 4 — what's new, split into "your competitors" vs "around you" */}
        <section className="card lg:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛰️</span>What&apos;s new</h2>
            <Link href="/feed" className="text-xs font-medium text-brand hover:underline">feed →</Link>
          </div>
          {!competitorItems.length && !aroundItems.length ? (
            <p className="mt-4 text-sm text-ink-faint">Nothing new yet — competitor moves, new openings and trends will show here.</p>
          ) : (
            <div className="mt-4 space-y-4">
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Your competitors</p>
                {competitorItems.length ? (
                  <ul className="space-y-1.5">{competitorItems.map(renderRow)}</ul>
                ) : (
                  <p className="text-sm text-ink-faint">No competitor moves detected yet.</p>
                )}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Around you</p>
                {aroundItems.length ? (
                  <ul className="space-y-1.5">{aroundItems.map(renderRow)}</ul>
                ) : (
                  <p className="text-sm text-ink-faint">No local news or openings yet.</p>
                )}
              </div>
            </div>
          )}
        </section>

        {/* 5 — competitors at a glance */}
        <section className="card lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🧭</span>Competitors</h2>
            <Link href="/competitors" className="text-xs font-medium text-brand hover:underline">manage →</Link>
          </div>
          <ul className="mt-3 space-y-1">
            {leaderboard.map((b, i) => (
              <li key={i} className={`flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-sm ${b.isTarget ? "bg-brand-soft/40" : ""}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{b.isTarget && <span className="mr-1 text-xs font-semibold text-brand">You ·</span>}{b.name}</span>
                  {b.sources.length > 1 && (
                    <span className="text-[10px] text-ink-faint">{b.sources.map((s) => `${SRC_ABBR[s.source] ?? s.source} ${s.rating}★`).join(" · ")}</span>
                  )}
                </span>
                <span className="shrink-0 font-medium">{b.rating != null ? `${b.rating}★` : "—"}</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-ink-faint">{b.price != null ? `$${Number(b.price).toFixed(0)}` : "—"}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
