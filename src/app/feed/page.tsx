import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ProvenanceBadge } from "@/components/TrustChip";
import { getOrMakeNewsDigest } from "@/lib/newsdigest";
import { MarketTabs } from "@/components/MarketTabs";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // room for the news-digest LLM call on first (uncached) load

const GROUP_COLOR: Record<string, string> = {
  price: "bg-trust-inferred/10 text-trust-inferred",
  promotion: "bg-brand-soft text-brand",
  offering: "bg-trust-corroborated/10 text-trust-corroborated",
  reputation: "bg-trust-direct/10 text-trust-direct",
  operations: "bg-surface-sunken text-ink-soft",
  content: "bg-surface-sunken text-ink-soft",
  market: "bg-surface-sunken text-ink-soft",
};

export default async function FeedPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Market feed" />;

  const ids = await workspaceBusinessIds(state.workspace);
  const supabase = await createClient();
  const idFilter = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];

  const [{ data: events }, { data: items }, { data: news }] = await Promise.all([
    supabase
      .from("market_event")
      .select("id,event_group,event_type,significance,summary,time_start,business:business_id(canonical_name)")
      .eq("workspace_id", state.workspace.id)
      .order("time_start", { ascending: false })
      .order("significance", { ascending: false })
      .limit(60),
    supabase
      .from("content_item")
      .select("id,platform,provenance,url,observed_at,business:business_id(canonical_name)")
      .in("business_id", idFilter)
      .neq("platform", "news")
      .order("observed_at", { ascending: false })
      .limit(60),
    supabase
      .from("content_item")
      .select("id,text,url,media,published_at,observed_at")
      .in("business_id", idFilter)
      .eq("platform", "news")
      .order("published_at", { ascending: false })
      .limit(14),
  ]);

  const NEWS_KIND: Record<string, string> = { trend: "📈 Trend", opening: "✨ New opening", local: "📰 Local" };
  const digest = await getOrMakeNewsDigest(state.workspace);

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Market feed</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          What changed across {state.workspace.name} and its competitors — price moves, new items,
          promotions — plus the raw sources they came from.
        </p>
      </div>

      <MarketTabs />

      {news && news.length > 0 && (
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛰️</span>
            Around you &amp; your industry
          </h2>
          <p className="mb-3 text-xs text-ink-faint">Summarized so you get it at a glance — sources linked, no need to open each one.</p>
          {digest.summary && <p className="mb-3 max-w-3xl text-sm text-ink-soft">{digest.summary}</p>}
          {digest.items.length > 0 ? (
            <ul className="stagger space-y-1.5">
              {digest.items.map((it, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2 rounded-2xl bg-white/55 p-3 text-sm">
                  <span className="chip shrink-0 bg-brand-soft text-brand-deep">{NEWS_KIND[it.kind ?? ""] ?? "News"}</span>
                  <span className="min-w-0 flex-1 text-ink">{it.point}</span>
                  {it.source && (it.url
                    ? <a href={it.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand hover:underline">{it.source} ↗</a>
                    : <span className="shrink-0 text-xs text-ink-faint">{it.source}</span>)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-faint">Gathering local news — a summary will appear here after the next scan.</p>
          )}
        </section>
      )}

      <section className="card">
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">◫</span>
          Changes detected
        </h2>
        {!events?.length ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-faint">
            No changes yet. These appear after a business is re-collected and something moved
            (price, new dish, a promotion starting). Re-run collection to build history.
          </p>
        ) : (
          <ul className="stagger space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-3 rounded-2xl bg-white/55 p-3 text-sm">
                <span className={`chip shrink-0 ${GROUP_COLOR[e.event_group] ?? "bg-surface-sunken text-ink-soft"}`}>
                  {String(e.event_type).replace(/_/g, " ")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{(e.business as any)?.canonical_name ?? "—"}</span>
                  <span className="ml-2 text-ink-soft">{e.summary}</span>
                </span>
                <span
                  className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-sunken"
                  title={`significance ${Math.round(Number(e.significance) * 100)}%`}
                >
                  <span className="block h-full rounded-full bg-brand-gradient" style={{ width: `${Number(e.significance) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">◎</span>
          Observed sources
        </h2>
        {!items?.length ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-faint">
            Nothing observed yet. Run a collection to seed the feed.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-white/55 p-3 text-sm">
                <span className="font-medium">{(it.business as any)?.canonical_name ?? "Unknown"}</span>
                <span className="chip bg-surface-sunken text-ink-soft">{it.platform}</span>
                {it.url && (
                  <a href={it.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-brand hover:underline">
                    {it.url}
                  </a>
                )}
                <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
                  <ProvenanceBadge provenance={it.provenance} />
                  {new Date(it.observed_at as string).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
