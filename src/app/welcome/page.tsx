import { redirect } from "next/navigation";
import { getUser, isSupabaseConfigured } from "@/lib/auth";
import { WelcomeForm } from "./WelcomeForm";

export const metadata = { title: "Welcome — Ask Rani Insights" };
export const dynamic = "force-dynamic";

/**
 * First-run profile capture. Reached right after a user's first sign-in (the
 * middleware gate routes any signed-in user whose profile_complete flag isn't set
 * here). Registered users arrive with name/business pre-filled from the metadata
 * they gave at sign-up — one confirm click; phone-first sign-ins fill it in.
 */
export default async function WelcomePage() {
  if (!isSupabaseConfigured()) redirect("/login");
  const user = await getUser();
  if (!user) redirect("/login");

  const md = (user.user_metadata ?? {}) as Record<string, unknown>;
  const hasPhone = !!user.phone || md.phone_captured === true;
  // Fully set up AND has a phone → into the app. A profile-complete user who still
  // has no phone falls through to the form in phone-only backfill mode.
  if (md.profile_complete === true && hasPhone) redirect("/onboarding");

  return (
    <WelcomeForm
      needPhoneOnly={md.profile_complete === true}
      prefill={{
        name: (md.full_name as string) ?? "",
        business: (md.business_name as string) ?? "",
        email: user.email ?? (md.signup_email as string) ?? "",
        phone: user.phone ? `+${user.phone}` : "",
      }}
    />
  );
}
