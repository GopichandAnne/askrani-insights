import { redirect } from "next/navigation";
import { getUser, isSuperAdmin, isServiceConfigured } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { providerHealth } from "@/lib/providers/registry";
import { isLlmConfigured, getLlm } from "@/lib/extraction/llm";

export const metadata = { title: "Super Admin — Ask Rani Insights" };
export const dynamic = "force-dynamic";

async function count(svc: any, table: string, filter?: (q: any) => any): Promise<number> {
  let q = svc.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count } = await q;
  return count ?? 0;
}

export default async function AdminPage() {
  const user = await getUser();
  if (!isSuperAdmin(user)) {
    // not a platform admin — send home
    redirect("/");
  }

  const health = await providerHealth();
  let llmLine = "not configured";
  if (isLlmConfigured()) {
    const llm = getLlm();
    llmLine = `${llm.provider} · extract=${llm.modelFor("extract")} · classify=${llm.modelFor("classify")}`;
  }

  const svc = isServiceConfigured() ? createServiceClient() : null;
  const stats = svc
    ? {
        orgs: await count(svc, "organization"),
        members: await count(svc, "org_membership"),
        workspaces: await count(svc, "workspace"),
        businesses: await count(svc, "business"),
        offers: await count(svc, "offer"),
        content: await count(svc, "content_item"),
        events: await count(svc, "market_event"),
        reviewPending: await count(svc, "observation", (q: any) => q.eq("review", "pending")),
        jobPending: await count(svc, "collection_job", (q: any) => q.eq("status", "pending")),
        jobRunning: await count(svc, "collection_job", (q: any) => q.eq("status", "running")),
        jobError: await count(svc, "collection_job", (q: any) => q.eq("status", "error")),
      }
    : null;

  const { data: runs } = svc
    ? await svc
        .from("provider_run")
        .select("provider,result_count,cost_usd,status,started_at,error")
        .order("started_at", { ascending: false })
        .limit(12)
    : { data: [] as any[] };

  const { data: recentBiz } = svc
    ? await svc.from("business").select("canonical_name,website,attributes").order("created_at", { ascending: false }).limit(8)
    : { data: [] as any[] };

  return (
    <div className="space-y-8 animate-fade-in">
      <section>
        <h1 className="text-3xl font-extrabold tracking-tight">Super Admin</h1>
        <p className="mt-1 text-ink-soft">Platform setup, health and operations. Signed in as {user!.email}.</p>
      </section>

      {/* platform stats */}
      {stats && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {[
            ["Organizations", stats.orgs],
            ["Members", stats.members],
            ["Workspaces", stats.workspaces],
            ["Businesses", stats.businesses],
            ["Offers", stats.offers],
            ["Content items", stats.content],
            ["Market events", stats.events],
            ["Review queue", stats.reviewPending],
            ["Jobs pending", stats.jobPending],
            ["Jobs running", stats.jobRunning],
            ["Jobs errored", stats.jobError],
          ].map(([label, n]) => (
            <div key={label as string} className="card">
              <div className="text-2xl font-extrabold text-brand-deep">{n as number}</div>
              <div className="mt-1 text-xs text-ink-faint">{label as string}</div>
            </div>
          ))}
        </section>
      )}

      {/* providers & models */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Data sources &amp; models</h2>
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left text-ink-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Configured</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {health.map((h) => (
                <tr key={h.provider} className="border-t border-line">
                  <td className="px-4 py-2 font-medium capitalize">{h.provider}</td>
                  <td className="px-4 py-2">
                    <span className={h.configured ? "text-trust-direct" : "text-ink-faint"}>{h.configured ? "yes" : "no"}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={h.ok ? "text-trust-direct" : "text-ink-faint"}>{h.ok ? "ok" : "inactive"}</span>
                  </td>
                  <td className="px-4 py-2 text-ink-faint">{h.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm">
          <span className="font-medium">AI extraction:</span> <span className="text-ink-soft">{llmLine}</span>
        </p>
      </section>

      {/* recent provider runs (cost/ops) */}
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-lg font-semibold">Recent collection runs</h2>
          {!runs?.length ? (
            <p className="card text-sm text-ink-faint">No runs yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <table className="w-full text-sm">
                <tbody>
                  {runs.map((r: any, i: number) => (
                    <tr key={i} className="border-t border-line first:border-t-0">
                      <td className="px-4 py-2 font-medium capitalize">{r.provider}</td>
                      <td className="px-4 py-2 text-ink-faint">{r.result_count ?? 0} items</td>
                      <td className="px-4 py-2">
                        <span className={r.status === "succeeded" ? "text-trust-direct" : r.status === "failed" ? "text-trust-low" : "text-ink-faint"}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-ink-faint">
                        {r.started_at ? new Date(r.started_at).toLocaleString() : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-lg font-semibold">Recent businesses</h2>
          {!recentBiz?.length ? (
            <p className="card text-sm text-ink-faint">No businesses yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {recentBiz.map((b: any, i: number) => (
                <li key={i} className="flex items-center justify-between rounded-lg border border-line bg-surface p-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{b.canonical_name}</span>
                    <span className="ml-2 truncate text-xs text-ink-faint">{b.website ?? ""}</span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {b.attributes?.last_collected_at ? "collected" : "queued"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
