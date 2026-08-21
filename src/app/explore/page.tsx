import { ExploreClient } from "@/components/ExploreClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Watch a new market — Ask Rani Insights" };

/**
 * Watch a new market — the on-ramp for adding another area or business to your
 * account. Scan any zip/city free (who's there, ranked by rating), read the
 * market, then start watching the area or a business in it. Not a daily feature;
 * the front door for standing up a new workspace.
 */
export default function ExplorePage() {
  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Start watching something new</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Watch a new market</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Scan any area free to see who&apos;s there — ranked by rating — then start watching the whole
          market or a single business in it. Type a zip or city and what you&apos;re after to begin.
        </p>
      </header>
      <ExploreClient />
    </div>
  );
}
