import Link from "next/link";
import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { Landing } from "@/components/Landing";

export const dynamic = "force-dynamic";

/**
 * Root. Signed-out visitors get the marketing Landing (the product front door).
 * Signed-in users get "Today" — the guide's primary screen (12.1): what changed
 * + what to do. A brand-new signed-in user is walked to setup.
 */
export default async function TodayPage() {
  const state = await activeWorkspace();

  // Front door for anyone not signed in (or before Supabase is set up).
  if (state.status === "signedout" || state.status === "unconfigured") {
    return <Landing />;
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          What changed in your local market, and what to do about it.
        </p>
      </section>

      {state.status === "empty" ? (
        <SetUpCta />
      ) : (
        <Dashboard workspaceId={state.workspace.id} name={state.workspace.name} />
      )}
    </div>
  );
}

function SetUpCta() {
  return (
    <section className="flex flex-col items-center gap-4 rounded-xl bg-brand-hero p-10 text-center text-white shadow-brand">
      <h2 className="font-display text-2xl font-extrabold">Let&apos;s set up your business</h2>
      <p className="max-w-md text-white/90">
        Search your business, we&apos;ll find your local competitors and start gathering everything
        about your market — automatically. Takes about two minutes.
      </p>
      <Link href="/onboarding" className="btn bg-white px-6 py-3 font-semibold text-brand-deep hover:-translate-y-0.5">
        Get started
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
