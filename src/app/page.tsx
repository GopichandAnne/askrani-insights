import Link from "next/link";
import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * "Today" — the guide's primary screen (12.1): prioritized changes and actions.
 * Shows recent detected changes + the top recommendations for the active
 * workspace; falls back to a getting-started state otherwise.
 */
export default async function TodayPage() {
  const state = await activeWorkspace();

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          What changed in your local market, why it matters, and what to do next —
          every item carries its source and confidence.
        </p>
      </section>

      {state.status !== "ok" ? (
        <FirstRun reason={state.status} />
      ) : (
        <Dashboard workspaceId={state.workspace.id} name={state.workspace.name} />
      )}
    </div>
  );
}

function FirstRun({ reason }: { reason: "unconfigured" | "signedout" | "empty" }) {
  const msg =
    reason === "unconfigured"
      ? "Add your Supabase keys to .env.local to get started."
      : reason === "signedout"
        ? "Sign in to set up your workspace."
        : "Set up your business and we'll start monitoring your local market.";
  const cta = reason === "signedout" ? { href: "/login", label: "Sign in" } : { href: "/onboarding", label: "Set up your workspace" };
  return (
    <section className="rounded-xl border border-line bg-surface p-6">
      <p className="text-ink-soft">{msg}</p>
      <Link href={cta.href} className="mt-4 inline-flex rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">
        {cta.label}
      </Link>
    </section>
  );
}

async function Dashboard({ workspaceId, name }: { workspaceId: string; name: string }) {
  const supabase = await createClient();
  const [{ data: events }, { data: recs }] = await Promise.all([
    supabase
      .from("market_event")
      .select("id,event_type,significance,summary,business:business_id(canonical_name)")
      .eq("workspace_id", workspaceId)
      .order("time_start", { ascending: false })
      .order("significance", { ascending: false })
      .limit(6),
    supabase
      .from("recommendation")
      .select("id,category,title,action,priority")
      .eq("workspace_id", workspaceId)
      .neq("status", "dismissed")
      .order("priority", { ascending: false })
      .limit(4),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">What changed</h2>
          <Link href="/feed" className="text-xs text-brand hover:underline">feed →</Link>
        </div>
        {!events?.length ? (
          <p className="mt-3 text-sm text-ink-faint">
            No changes yet — they appear once a business is re-collected and something moves.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="chip shrink-0 bg-surface-sunken text-ink-soft">{String(e.event_type).replace(/_/g, " ")}</span>
                <span className="text-ink-soft">
                  <span className="font-medium text-ink">{(e.business as any)?.canonical_name}</span> — {e.summary}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Top actions</h2>
          <Link href="/recommendations" className="text-xs text-brand hover:underline">all →</Link>
        </div>
        {!recs?.length ? (
          <p className="mt-3 text-sm text-ink-faint">No recommendations yet for {name}.</p>
        ) : (
          <ul className="mt-3 space-y-3 text-sm">
            {recs.map((r) => (
              <li key={r.id}>
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
  );
}
