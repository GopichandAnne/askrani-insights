import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { DraftButton } from "@/components/DraftButton";
import { getOrMakeContent, type SwipePost, type CollabItem } from "@/lib/content";
import { getOrMakeIndustryBest, type IndustryBestPost } from "@/lib/industry";
import { getAdsReport } from "@/lib/ads";
import type { SocialPulse } from "@/lib/socialpulse";
import { PulseColumns } from "@/components/PulseColumns";

export const dynamic = "force-dynamic";
export const maxDuration = 45; // room for the content LLM read on a cold cache

const PLATFORM_ICON: Record<string, string> = { instagram: "📸", facebook: "👍", tiktok: "🎵", youtube: "▶️" };
const num = (n?: number) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

function Swipe({ p }: { p: SwipePost }) {
  return (
    <div className="card flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5"><span aria-hidden>{PLATFORM_ICON[p.platform] ?? "•"}</span>{p.business}</span>
        <span className="flex items-center gap-2">
          {num(p.views) && <span>👁 {num(p.views)}</span>}
          {num(p.likes) && <span>❤ {num(p.likes)}</span>}
          {num(p.comments) && <span>💬 {num(p.comments)}</span>}
        </span>
      </div>
      <span className="chip w-fit bg-brand-soft text-brand">{p.format}</span>
      <p className="line-clamp-2 text-sm text-ink-soft">{p.caption || "(no caption)"}</p>
      <p className="text-xs text-ink-faint"><span className="font-medium text-ink-soft">Why it works:</span> {p.whyItWorks}</p>
      <div className="mt-auto rounded-2xl bg-brand-soft/50 p-2.5">
        <p className="text-sm text-brand-deep"><span className="font-semibold">Your version:</span> {p.yourVersion}</p>
        <div className="mt-2 flex items-center gap-2">
          <DraftButton move={p.yourVersion} context={`Swipe from ${p.business}: ${p.format}`} />
          {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">See the original ↗</a>}
        </div>
      </div>
    </div>
  );
}

function Collab({ c }: { c: CollabItem }) {
  return (
    <li className="flex flex-col gap-1 rounded-2xl bg-white/55 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-brand-deep">@{c.handle}</span>
        <span className="chip bg-surface-sunken text-ink-faint">{c.whoTheyAre}</span>
        {c.mentions > 0 && <span className="text-xs text-ink-faint">tagged {c.mentions}× by {c.byRivals.slice(0, 2).join(", ")}{c.byRivals.length > 2 ? "…" : ""}</span>}
      </div>
      <p className="text-sm text-ink-soft">{c.why}</p>
      <div className="flex gap-3 text-xs">
        <a href={`https://instagram.com/${c.handle}`} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">View profile ↗</a>
        {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="text-ink-faint hover:underline">The post that tagged them ↗</a>}
      </div>
    </li>
  );
}

function IndustrySwipe({ p }: { p: IndustryBestPost }) {
  return (
    <div className="card flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
        <span className="flex items-center gap-1.5"><span aria-hidden>🌎</span>@{p.authorHandle ?? "creator"}</span>
        <span className="flex items-center gap-2">
          {num(p.views) && <span>👁 {num(p.views)}</span>}
          {num(p.likes) && <span>❤ {num(p.likes)}</span>}
          {num(p.comments) && <span>💬 {num(p.comments)}</span>}
        </span>
      </div>
      <span className="chip w-fit bg-brand-soft text-brand">{p.format}</span>
      <p className="line-clamp-2 text-sm text-ink-soft">{p.caption || "(no caption)"}</p>
      <p className="text-xs text-ink-faint"><span className="font-medium text-ink-soft">Why it works:</span> {p.whyItWorks}</p>
      <div className="mt-auto rounded-2xl bg-brand-soft/50 p-2.5">
        <p className="text-sm text-brand-deep"><span className="font-semibold">Your version:</span> {p.yourVersion}</p>
        <div className="mt-2 flex items-center gap-2">
          <DraftButton move={p.yourVersion} context={`National industry format: ${p.format}`} />
          {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">See the original ↗</a>}
        </div>
      </div>
    </div>
  );
}

function SocialPulseSection({ p }: { p: SocialPulse }) {
  return (
    <section className="card">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🚀</span>
        What&apos;s moving in social this week
      </h2>
      {p.summary && <p className="text-sm text-ink-soft">{p.summary}</p>}

      {p.breakouts.length > 0 && (
        <div className="mt-3 space-y-2">
          {p.breakouts.map((b, i) => (
            <div key={i} className="rounded-2xl bg-white/55 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="chip bg-coral/15 text-coral-dark">🚀 {b.multiple}× usual</span>
                <span className="font-semibold text-ink">{b.rival}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{b.caption}</p>
              <div className="mt-2 flex items-center gap-2">
                <DraftButton move={`Make our version of this post that's working for ${b.rival}: ${b.caption}`} context="Rival breakout post" />
                {b.url && <a href={b.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">See the original ↗</a>}
              </div>
            </div>
          ))}
        </div>
      )}

      {(p.risingFormats.length > 0 || p.fadingFormats.length > 0 || p.newCollabs.length > 0) && (
        <PulseColumns columns={[
          { title: "↑ Rising formats", tone: "text-brand-deep", items: p.risingFormats, empty: "—" },
          { title: "↓ Fading formats", tone: "text-ink-faint", items: p.fadingFormats, empty: "—" },
          { title: "🤝 New collabs", tone: "text-brand-deep", items: p.newCollabs.map((h) => `@${h}`), empty: "None new" },
        ]} />
      )}
    </section>
  );
}

export default async function ContentPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Content" />;

  const [c, industry, ads] = await Promise.all([
    getOrMakeContent(state.workspace),
    getOrMakeIndustryBest(state.workspace),
    getAdsReport(state.workspace),
  ]);
  // social pulse — cached read only (warmed on collection), so the page stays fast
  const supabase = await createClient();
  const { data: spRow } = await supabase.from("workspace").select("goals").eq("id", state.workspace.id).maybeSingle();
  const pulse = (spRow?.goals as any)?.socialPulse as SocialPulse | undefined;
  const hasPulse = !!pulse && !pulse.failed && (pulse.breakouts.length > 0 || pulse.risingFormats.length > 0 || pulse.newCollabs.length > 0 || !!pulse.summary);

  const nothing = !c.summary && c.swipe.length === 0 && c.collabs.length === 0 && industry.best.length === 0 && ads.ads.length === 0 && !hasPulse;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Content</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          What&apos;s actually working on your rivals&apos; feeds — the posts worth copying (with a ready version for you),
          the creators they collaborate with, and the hashtags they ride.
        </p>
      </div>

      {nothing ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">Nothing yet.</span> Once we&apos;ve collected your rivals&apos; social posts,
            we&apos;ll pull out the best-performing content, the creators they work with, and the hashtags they use.
          </p>
        </div>
      ) : (
        <>
          {c.summary && (
            <section className="card bg-brand-hero text-white">
              <h2 className="flex items-center gap-2 font-display text-lg font-extrabold">
                <span aria-hidden>🎬</span> The content play
              </h2>
              <p className="mt-1.5 max-w-3xl text-sm text-white/90">{c.summary}</p>
            </section>
          )}

          {hasPulse && pulse && <SocialPulseSection p={pulse} />}

          {c.swipe.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">✂️</span>
                Swipe file — steal these formats
              </h2>
              <div className="grid items-start gap-4 md:grid-cols-2">
                {c.swipe.map((p, i) => <Swipe key={i} p={p} />)}
              </div>
            </section>
          )}

          {industry.best.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-semibold">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">🌎</span>
                  Winning in your industry — nationally
                </h2>
                <span className="text-xs text-ink-faint">from top hashtag content, not a follow list</span>
              </div>
              {industry.summary && <p className="mb-3 max-w-3xl text-sm text-ink-soft">{industry.summary}</p>}
              <div className="grid items-start gap-4 md:grid-cols-2">
                {industry.best.map((p, i) => <IndustrySwipe key={i} p={p} />)}
              </div>
            </section>
          )}

          {ads.ads.length > 0 && (
            <section className="card">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-semibold">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">📣</span>
                  What rivals are paying to promote
                </h2>
                <span className="text-xs text-ink-faint">{ads.advertisers.length} advertiser{ads.advertisers.length === 1 ? "" : "s"} · Meta Ad Library</span>
              </div>
              {ads.summary && <p className="mb-3 max-w-3xl text-sm text-ink-soft">{ads.summary}</p>}
              {ads.patterns.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {ads.patterns.map((p, i) => <span key={i} className="chip bg-brand-soft text-brand" title={p.example ?? ""}>{p.pattern}</span>)}
                </div>
              )}
              <div className="grid items-start gap-3 md:grid-cols-2">
                {ads.ads.slice(0, 8).map((a, i) => (
                  <div key={i} className="rounded-2xl bg-white/55 p-3 text-sm">
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-faint">
                      <span className="font-medium text-ink-soft">{a.advertiser}</span>
                      {a.cta && <span className="chip bg-surface-sunken text-ink-faint">{a.cta}</span>}
                    </div>
                    <p className="line-clamp-3 text-ink-soft">{a.text || "(image ad)"}</p>
                    {a.snapshotUrl && <a href={a.snapshotUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex text-xs font-medium text-brand hover:underline">See the ad ↗</a>}
                  </div>
                ))}
              </div>
              {ads.moves.length > 0 && (
                <div className="mt-3 rounded-2xl bg-brand-soft/50 p-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-deep">Your moves</p>
                  <ul className="space-y-1 text-sm text-brand-deep">{ads.moves.map((m, i) => <li key={i}>✦ {m}</li>)}</ul>
                </div>
              )}
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            {c.collabs.length > 0 && (
              <section className="card">
                <h2 className="mb-3 flex items-center gap-2 font-semibold">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🤝</span>
                  Collab &amp; influencer radar
                </h2>
                <p className="mb-2.5 text-xs text-ink-faint">Accounts your rivals tag — creators and partners worth reaching out to.</p>
                <ul className="stagger space-y-2">{c.collabs.map((x, i) => <Collab key={i} c={x} />)}</ul>
              </section>
            )}

            {c.hashtags.length > 0 && (
              <section className="card">
                <h2 className="mb-3 flex items-center gap-2 font-semibold">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">#️⃣</span>
                  Hashtags your rivals ride
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {c.hashtags.map((h, i) => (
                    <span key={i} className="chip bg-surface-sunken text-ink-soft">#{h.tag} <span className="ml-1 text-ink-faint">{h.count}</span></span>
                  ))}
                </div>
                <p className="mt-3 text-xs text-ink-faint">The tags showing up most across your rivals&apos; posts — worth testing on your own.</p>
              </section>
            )}
          </div>

          <p className="text-center text-xs text-ink-faint">From {c.postsSeen} rival posts · updates after each scan.</p>
        </>
      )}
    </div>
  );
}
