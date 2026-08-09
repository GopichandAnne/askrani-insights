import Link from "next/link";
import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ProvenanceBadge } from "@/components/TrustChip";
import { MarketTabs } from "@/components/MarketTabs";

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

  const admin = isSuperAdmin(await getUser());
  const ids = await workspaceBusinessIds(state.workspace);
  const supabase = await createClient();
  const idFilter = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];

  // The full change log across the market. News/trends moved to "Around me";
  // the raw "observed sources" list is a debug view, shown to platform admins only.
  const [{ data: events }, { data: items }] = await Promise.all([
    supabase
      .from("market_event")
      .select("id,event_group,event_type,significance,summary,time_start,business:business_id(canonical_name)")
      .eq("workspace_id", state.workspace.id)
      .order("time_start", { ascending: false })
      .order("significance", { ascending: false })
      .limit(80),
    admin
      ? supabase
          .from("content_item")
          .select("id,platform,provenance,url,observed_at,business:business_id(canonical_name)")
          .in("business_id", idFilter)
          .neq("platform", "news")
          .order("observed_at", { ascending: false })
          .limit(60)
      : Promise.resolve({ data: null }),
  ]);

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Changes</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Every change we&apos;ve detected across {state.workspace.name} and its competitors — price
          moves, new items, promotions. Local news &amp; trends live in{" "}
          <Link href="/around" className="font-medium text-brand hover:underline">Around me</Link>.
        </p>
      </div>

      <MarketTabs />

      <section className="card">
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">◫</span>
          Changes detected
        </h2>
        {!events?.length ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-faint">
            No changes yet. These appear after a business is re-collected and something moved
            (price, new item, a promotion starting). Re-run collection to build history.
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

      {/* Raw observed sources — debug view, platform admins only. */}
      {admin && items && items.length > 0 && (
        <section className="card">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-surface-sunken text-ink-soft">◎</span>
            Observed sources
            <span className="chip bg-surface-sunken text-ink-faint">admin</span>
          </h2>
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
        </section>
      )}
    </div>
  );
}
