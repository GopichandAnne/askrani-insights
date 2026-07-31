import { SearchFlow } from "./SearchFlow";
import { getUser, isSupabaseConfigured } from "@/lib/auth";
import Link from "next/link";
import { RaniMark } from "@/components/RaniSpinner";

export const metadata = { title: "Set up your workspace — Ask Rani Insights" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const configured = isSupabaseConfigured();
  const user = configured ? await getUser() : null;

  return (
    <div className="animate-fade-in space-y-6">
      <section className="glass-strong relative overflow-hidden rounded-3xl p-7">
        <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.1]" aria-hidden />
        <div className="pointer-events-none absolute -right-6 -top-10 h-32 w-32 rounded-full bg-brand/20 blur-2xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-gradient text-white shadow-brand"><RaniMark size={26} /></div>
          <div>
            <h1 className="font-display text-2xl font-extrabold italic sm:text-3xl">Set up your workspace</h1>
            <p className="text-sm text-ink-soft">Find your business, review your competitors, and choose when to collect.</p>
          </div>
        </div>
        <p className="relative mt-3 max-w-2xl text-sm text-ink-soft">
          We detect your business type and cuisine, rank your closest like-for-like rivals, then gather
          everything available — websites, menus, offers, reviews. Every fact keeps its source and confidence.
        </p>
      </section>

      {!configured ? (
        <p className="card text-sm text-ink-soft">
          Supabase isn’t configured yet. Add the keys to <code>.env.local</code> to enable this.
        </p>
      ) : !user ? (
        <div className="card text-sm text-ink-soft">
          <p>Sign in to create a workspace and save your market intelligence.</p>
          <Link href="/login" className="btn btn-primary mt-3 px-5 py-2.5">Sign in</Link>
        </div>
      ) : (
        <SearchFlow />
      )}
    </div>
  );
}
