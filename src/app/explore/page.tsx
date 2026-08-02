import { ExploreClient } from "@/components/ExploreClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Explore an area — Ask Rani Insights" };

/**
 * Explore — a no-setup market scan. Type a zip/city + what you're looking for and
 * see who's there, ranked by rating. The front door for anyone sizing up an area
 * (opening a spot, scoping competition) before setting up a business.
 */
export default function ExplorePage() {
  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Explore an area</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          See who&apos;s in any neighborhood — ranked by rating — before you set anything up. Type a zip or city
          and what you&apos;re after. Great for sizing up competition or picking where to open.
        </p>
      </header>
      <ExploreClient />
    </div>
  );
}
