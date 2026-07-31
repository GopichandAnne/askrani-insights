import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { TrustChip, ProvenanceBadge } from "@/components/TrustChip";

export const dynamic = "force-dynamic";

export default async function OffersPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Offers & pricing" />;

  const ids = await workspaceBusinessIds(state.workspace);
  const supabase = await createClient();
  const { data: offers } = await supabase
    .from("offer")
    .select("id,entity_text,offer_type,pricing,confidence,provenance,observed_at,business_id,business:business_id(canonical_name)")
    .in("business_id", ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"])
    .order("observed_at", { ascending: false })
    .limit(400);

  // group by business, keep latest observation per entity_text
  const byBiz = new Map<string, { name: string; isTarget: boolean; rows: any[] }>();
  for (const o of offers ?? []) {
    const name = (o.business as any)?.canonical_name ?? "Unknown";
    const key = o.business_id as string;
    if (!byBiz.has(key))
      byBiz.set(key, { name, isTarget: key === ids.targetId, rows: [] });
    const bucket = byBiz.get(key)!;
    if (!bucket.rows.some((r) => r.entity_text.toLowerCase() === (o.entity_text as string).toLowerCase())) {
      bucket.rows.push(o);
    }
  }
  const groups = [...byBiz.values()].sort((a, b) => Number(b.isTarget) - Number(a.isTarget));

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Offers &amp; pricing</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Menu items and prices for {state.workspace.name} and your competitors, side by side. Each
          one shows where we found it and how sure we are.
        </p>
      </div>

      {!groups.length ? (
        <p className="card border-dashed text-sm text-ink-soft">
          No offers saved yet. Run a market analysis to populate this.
        </p>
      ) : (
        <div className="stagger grid gap-4 lg:grid-cols-2">
          {groups.map((g, i) => (
            <div key={i} className={`card card-hover ${g.isTarget ? "ring-1 ring-brand/40" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold">
                  {g.name} {g.isTarget && <span className="chip ml-1 bg-brand-soft text-brand">you</span>}
                </span>
                <span className="chip bg-surface-sunken text-ink-faint">{g.rows.length} offers</span>
              </div>
              <ul className="mt-3 divide-y divide-line/50">
                {g.rows.slice(0, 20).map((o) => {
                  const amount = (o.pricing as any)?.amount;
                  return (
                    <li key={o.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="truncate">{o.entity_text}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {amount != null && <span className="font-semibold text-brand-deep">${amount}</span>}
                        <TrustChip confidence={Number(o.confidence)} />
                      </span>
                    </li>
                  );
                })}
              </ul>
              {g.rows[0] && (
                <div className="mt-3">
                  <ProvenanceBadge provenance={g.rows[0].provenance} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
