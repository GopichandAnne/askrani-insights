import { SearchFlow } from "./SearchFlow";
import { getUser, isSupabaseConfigured } from "@/lib/auth";
import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";

export const metadata = { title: "Set up your workspace — Ask Rani Insights" };
export const dynamic = "force-dynamic";

const STEPS = [
  ["1", "Find your business", "Search by name — we detect if it's a restaurant or grocery, and its cuisine."],
  ["2", "Review your competitors", "We rank like-for-like rivals first; edit the set until it's right."],
  ["3", "You start collecting", "When you're happy, press start — we gather menus, offers, reviews & social."],
];

export default async function OnboardingPage() {
  const configured = isSupabaseConfigured();
  const user = configured ? await getUser() : null;

  return (
    <div className="space-y-6 animate-fade-in">
      <section className="overflow-hidden rounded-xl bg-brand-hero p-8 text-white shadow-brand">
        <div className="flex items-center gap-3">
          <RaniMark size={40} />
          <h1 className="font-display text-3xl font-extrabold italic">Set up your workspace</h1>
        </div>
        <p className="mt-2 max-w-2xl text-white/85">
          Search your business — we detect its type and cuisine, then rank your closest like-for-like
          competitors. Review the set, then choose when to collect everything available — websites,
          menus, offers, reviews. Every fact keeps its source and confidence.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {STEPS.map(([n, t, d]) => (
            <div key={n} className="rounded-lg bg-white/10 p-3 backdrop-blur">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-white/20 text-xs font-bold">{n}</span>
                <span className="text-sm font-semibold">{t}</span>
              </div>
              <p className="mt-1 text-xs text-white/80">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {!configured ? (
        <p className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">
          Supabase isn’t configured yet. Add the keys to <code>.env.local</code> to enable this.
        </p>
      ) : !user ? (
        <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">
          <p>Sign in to create a workspace and save your market intelligence.</p>
          <Link href="/login" className="mt-3 inline-flex rounded-lg bg-brand px-4 py-2 font-medium text-white">
            Sign in
          </Link>
        </div>
      ) : (
        <SearchFlow />
      )}
    </div>
  );
}
