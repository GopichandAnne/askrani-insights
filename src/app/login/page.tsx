import { LoginClient } from "./LoginClient";
import { getUser, isSupabaseConfigured } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export const metadata = { title: "Sign in — local-intel" };

export default async function LoginPage() {
  if (isSupabaseConfigured()) {
    const user = await getUser();
    if (user) redirect("/onboarding");
  } else {
    return (
      <div className="mx-auto max-w-sm rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">
        <h1 className="text-lg font-semibold text-ink">Sign in unavailable</h1>
        <p className="mt-2">
          Supabase isn&apos;t configured yet. Add the Supabase keys to{" "}
          <code>.env.local</code> to enable accounts and saving.
        </p>
        <Link href="/onboarding" className="mt-3 inline-flex text-brand hover:underline">
          Run a market analysis without an account →
        </Link>
      </div>
    );
  }
  return <LoginClient />;
}
