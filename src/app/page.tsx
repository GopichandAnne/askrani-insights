import Link from "next/link";

/**
 * "Today" — the guide's primary screen (12.1): prioritized changes and actions.
 * Full data wiring lands with the workspace/recommendation work; this is the
 * shell plus a first-run state so the app runs before Supabase is configured.
 */
export default function TodayPage() {
  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          What changed in your local market, why it matters, and what to do
          next — every item carries its source, observed time, and confidence.
        </p>
      </section>

      {!configured && (
        <section className="rounded-xl border border-line bg-surface p-6">
          <h2 className="font-medium">Finish setup</h2>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>
              Create a Supabase project, then copy <code>.env.example</code> to{" "}
              <code>.env.local</code> and fill the Supabase keys.
            </li>
            <li>
              Apply the migration in <code>supabase/migrations</code> (canonical
              data model).
            </li>
            <li>
              Add <code>ANTHROPIC_API_KEY</code> to enable the extraction layer.
            </li>
            <li>
              Optional: add Google / Apify / Bright Data keys to activate those
              collection adapters.
            </li>
          </ol>
          <Link
            href="/onboarding"
            className="mt-4 inline-flex rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white"
          >
            Create your first workspace
          </Link>
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          {
            href: "/feed",
            title: "Market feed",
            body: "Unified competitor timeline: posts, promotions, menus, reviews.",
          },
          {
            href: "/offers",
            title: "Offers & pricing",
            body: "Structured dish/offer comparison with price history and evidence.",
          },
          {
            href: "/recommendations",
            title: "Recommendations",
            body: "Prioritized actions with rationale, evidence, impact and effort.",
          },
        ].map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-xl border border-line bg-surface p-5 hover:border-brand"
          >
            <div className="font-medium">{c.title}</div>
            <p className="mt-1 text-sm text-ink-soft">{c.body}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
