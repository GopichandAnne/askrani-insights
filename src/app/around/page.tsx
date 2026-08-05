import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { DraftButton } from "@/components/DraftButton";
import { getOrMakeNewsDigest, type DigestItem } from "@/lib/newsdigest";
import { getOrMakeLocalTrends, type TrendItem } from "@/lib/trending";

export const dynamic = "force-dynamic";
export const maxDuration = 45; // room for the digest + trends LLM calls on a cold cache

const MOMENTUM: Record<string, { chip: string; label: string }> = {
  hot: { chip: "bg-coral/15 text-coral-dark", label: "🔥 Hot" },
  rising: { chip: "bg-brand-soft text-brand", label: "📈 Rising" },
  steady: { chip: "bg-surface-sunken text-ink-soft", label: "• Steady" },
};

function TrendCard({ t }: { t: TrendItem }) {
  const m = MOMENTUM[t.momentum] ?? MOMENTUM.rising;
  return (
    <div className="rounded-2xl bg-white/55 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`chip ${m.chip}`}>{m.label}</span>
        <span className="font-semibold">{t.topic}</span>
      </div>
      <p className="mt-1.5 text-sm text-ink-soft">{t.evidence}</p>
      {t.competitors.length > 0 && (
        <p className="mt-1 text-xs text-ink-faint">Seen at: {t.competitors.join(", ")}</p>
      )}
      {t.yourMove && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="flex-1 text-sm text-brand-deep"><span aria-hidden>✦</span> <span className="font-semibold">Your move:</span> {t.yourMove}</p>
          <DraftButton move={t.yourMove} context={`Local trend: ${t.topic}`} />
        </div>
      )}
    </div>
  );
}

const KIND_META: Record<string, { icon: string; label: string }> = {
  opening: { icon: "✨", label: "New opening" },
  local: { icon: "📰", label: "Local" },
  trend: { icon: "📈", label: "Trend" },
};

function Item({ it }: { it: DigestItem }) {
  const m = KIND_META[it.kind ?? "local"] ?? KIND_META.local;
  return (
    <li className="flex flex-wrap items-baseline gap-2 rounded-2xl bg-white/55 p-3 text-sm">
      <span className="chip shrink-0 bg-brand-soft text-brand-deep">{m.icon} {m.label}</span>
      <span className="min-w-0 flex-1 text-ink">{it.point}</span>
      {it.source &&
        (it.url ? (
          <a href={it.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand hover:underline">
            {it.source} ↗
          </a>
        ) : (
          <span className="shrink-0 text-xs text-ink-faint">{it.source}</span>
        ))}
    </li>
  );
}

export default async function AroundPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Around me" />;

  const supabase = await createClient();
  const [digest, trends, { data: target }] = await Promise.all([
    getOrMakeNewsDigest(state.workspace),
    getOrMakeLocalTrends(state.workspace),
    state.workspace.target_business_id
      ? supabase.from("business").select("attributes").eq("id", state.workspace.target_business_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const area = (target as { attributes?: { address?: string } } | null)?.attributes?.address;
  const local = digest.items.filter((i) => i.kind === "local" || i.kind === "opening");
  const national = digest.items.filter((i) => i.kind === "trend");
  const nothing = !digest.summary && digest.items.length === 0 && trends.trends.length === 0;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Around me</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          What&apos;s happening in your area and your industry — summarized so you get it at a glance,
          every point linked to its source.{area ? <> Area: <span className="font-medium text-brand-deep">{area}</span>.</> : null}
        </p>
      </div>

      {nothing ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">Nothing yet.</span> After the next scan we&apos;ll gather local
            news, nearby openings and industry trends and summarize them here.
          </p>
        </div>
      ) : (
        <>
          {/* trending near you — from real local competitor engagement */}
          {trends.trends.length > 0 && (
            <section className="card">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-semibold">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">🔥</span>
                  Trending near you
                </h2>
                <span className="text-xs text-ink-faint">from your rivals&apos; engagement</span>
              </div>
              {trends.summary && <p className="mt-2 max-w-3xl text-sm text-ink-soft">{trends.summary}</p>}
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {trends.trends.map((t, i) => <TrendCard key={i} t={t} />)}
              </div>
            </section>
          )}

          {digest.summary && (
            <section className="card">
              <h2 className="mb-1 flex items-center gap-2 font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛰️</span>
                The short version
              </h2>
              <p className="max-w-3xl text-sm text-ink-soft">{digest.summary}</p>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card">
              <h2 className="mb-3 flex items-center gap-2 font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📍</span>
                In your area
              </h2>
              {local.length ? (
                <ul className="stagger space-y-1.5">{local.map((it, i) => <Item key={i} it={it} />)}</ul>
              ) : (
                <p className="text-sm text-ink-faint">No local news or nearby openings yet.</p>
              )}
            </section>

            <section className="card">
              <h2 className="mb-3 flex items-center gap-2 font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📈</span>
                In your industry
              </h2>
              {national.length ? (
                <ul className="stagger space-y-1.5">{national.map((it, i) => <Item key={i} it={it} />)}</ul>
              ) : (
                <p className="text-sm text-ink-faint">No industry trends captured yet.</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
