import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ProvenanceBadge } from "@/components/TrustChip";

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Market feed" />;

  const ids = await workspaceBusinessIds(state.workspace);
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("content_item")
    .select("id,platform,provenance,url,observed_at,business:business_id(canonical_name)")
    .in("business_id", ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"])
    .order("observed_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Market feed</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Observed sources across {state.workspace.name} and its competitors. As continuous monitoring
          lands, posts, promotions and price moves append here as market events.
        </p>
      </div>

      {!items?.length ? (
        <p className="rounded-xl border border-dashed border-line bg-surface p-6 text-sm text-ink-soft">
          Nothing observed yet. Run a market analysis to seed the feed.
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
    </div>
  );
}
