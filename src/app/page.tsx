import Link from "next/link";
import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { Landing } from "@/components/Landing";
import { RaniMark } from "@/components/RaniSpinner";

export const dynamic = "force-dynamic";

/**
 * Root. Signed-out visitors get the marketing Landing. Signed-in users get
 * "Today" — the guide's primary screen (12.1): what changed + what to do.
 */
export default async function TodayPage() {
  const state = await activeWorkspace();
  if (state.status === "signedout" || state.status === "unconfigured") return <Landing />;

  return (
    <div className="animate-fade-in space-y-8">
      <section>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Today</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">What changed in your local market, and what to do about it.</p>
      </section>

      {state.status === "empty" ? <SetUpCta /> : <Dashboard workspace={state.workspace} />}
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
          Search your business — we detect its type, find your local competitors, and gather everything
          about your market. Takes about two minutes.
        </p>
        <Link href="/onboarding" className="btn btn-primary mt-1 px-7 py-3.5 text-base">
          Get started <RaniMark size={18} />
        </Link>
      </div>
    </section>
  );
}

async function Dashboard({ workspace }: { workspace: { id: string; name: string } }) {
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(workspace as any);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [{ data: events }, { data: recs }, offersCount, eventsCount, recsCount] = await Promise.all([
    supabase
      .from("market_event")
      .select("id,event_type,significance,summary,business:business_id(canonical_name)")
      .eq("workspace_id", workspace.id)
      .order("time_start", { ascending: false })
      .order("significance", { ascending: false })
      .limit(6),
    supabase
      .from("recommendation")
      .select("id,category,title,action,priority")
      .eq("workspace_id", workspace.id)
      .neq("status", "dismissed")
      .order("priority", { ascending: false })
      .limit(4),
    supabase.from("offer").select("id", { count: "exact", head: true }).in("business_id", scope),
    supabase.from("market_event").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).gte("created_at", since),
    supabase.from("recommendation").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).neq("status", "dismissed"),
  ]);

  const stats = [
    { label: "Businesses watched", value: ids.all.length, href: "/competitors" },
    { label: "Offers tracked", value: offersCount.count ?? 0, href: "/offers" },
    { label: "Events (30d)", value: eventsCount.count ?? 0, href: "/feed" },
    { label: "Open actions", value: recsCount.count ?? 0, href: "/recommendations" },
  ];

  return (
    <div className="space-y-6">
      {/* stat tiles */}
      <section className="stagger grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="card card-hover glow-hover flex flex-col justify-between">
            <div className="text-3xl font-extrabold text-brand-deep">{s.value}</div>
            <div className="mt-1 text-xs font-medium text-ink-faint">{s.label}</div>
          </Link>
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* what changed */}
        <section className="card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">◫</span>
              What changed
            </h2>
            <Link href="/feed" className="text-xs font-medium text-brand hover:underline">feed →</Link>
          </div>
          {!events?.length ? (
            <p className="mt-4 text-sm text-ink-faint">
              No changes yet — they appear once a business is re-collected and something moves.
            </p>
          ) : (
            <ul className="mt-4 space-y-2 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex gap-2 rounded-2xl bg-white/50 p-2.5">
                  <span className="chip shrink-0 bg-surface-sunken text-ink-soft">{String(e.event_type).replace(/_/g, " ")}</span>
                  <span className="text-ink-soft">
                    <span className="font-medium text-ink">{(e.business as any)?.canonical_name}</span> — {e.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* top actions */}
        <section className="card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">✦</span>
              Top actions
            </h2>
            <Link href="/recommendations" className="text-xs font-medium text-brand hover:underline">all →</Link>
          </div>
          {!recs?.length ? (
            <p className="mt-4 text-sm text-ink-faint">No recommendations yet for {workspace.name}.</p>
          ) : (
            <ul className="mt-4 space-y-3 text-sm">
              {recs.map((r) => (
                <li key={r.id} className="rounded-2xl bg-white/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className="chip bg-brand-soft text-brand">{r.category}</span>
                    <span className="font-medium">{r.title}</span>
                  </div>
                  <p className="mt-0.5 text-ink-soft">{r.action}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
