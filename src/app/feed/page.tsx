import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ProvenanceBadge } from "@/components/TrustChip";

export const dynamic = "force-dynamic";

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

  const [{ data: events }, { data: items }] = await Promise.all([
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
      .order("observed_at", { ascending: false })
      .limit(60),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Market feed</h1>
        <p className="mt-1 text-sm text-ink-soft">
          What changed across {state.workspace.name} and its competitors — price moves, new items,
          promotions — plus the raw sources they came from. Changes appear once a business has been
          collected more than once.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">Changes detected</h2>
        {!events?.length ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-ink-faint">
            No changes yet. These appear after a business is re-collected and something moved
            (price, new dish, a promotion starting). Re-run collection to build history.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
                <span className={`chip ${GROUP_COLOR[e.event_group] ?? "bg-surface-sunken text-ink-soft"}`}>
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
                  <span className="block h-full bg-brand" style={{ width: `${Number(e.significance) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">Observed sources</h2>
        {!items?.length ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-ink-faint">
            Nothing observed yet. Run a collection to seed the feed.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
                <span className="font-medium">{(it.business as any)?.canonical_name ?? "Unknown"}</span>
                <span className="text-ink-faint">{it.platform}</span>
                {it.url && (
                  <a href={it.url} target="_blank" rel="noreferrer" className="truncate text-brand hover:underline">
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
