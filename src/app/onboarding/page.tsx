import { SearchFlow } from "./SearchFlow";
import { getUser, isSupabaseConfigured } from "@/lib/auth";
import Link from "next/link";

export const metadata = { title: "Set up your workspace — local-intel" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const configured = isSupabaseConfigured();
  const user = configured ? await getUser() : null;

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your workspace</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Search for your business, we auto-find your local competitors, and then
          collect everything available — websites, menus, offers, reviews — on its
          own. Every fact keeps its source and confidence.
        </p>
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
