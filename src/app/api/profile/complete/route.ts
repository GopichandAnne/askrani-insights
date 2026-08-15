import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * First-run profile capture. Called once from /welcome after a new user's first
 * sign-in (phone OTP or email link). It:
 *   1. bootstraps the org + grants the trial credits (requireOrg → ensureOrgForUser)
 *      — this is what phone sign-in otherwise skips, which is why a fresh phone
 *      login showed 0 credits;
 *   2. persists name + business to the auth user's metadata (the identity used
 *      everywhere, including the WhatsApp assistant), and flips profile_complete
 *      so the middleware gate stops routing them here;
 *   3. names the org from the business and stashes the owner's contact
 *      (name / phone / email) on organization.settings.ownerProfile — the phone
 *      is the hook the Rani WhatsApp assistant matches an owner on.
 */
export async function POST(req: Request) {
  const auth = await requireOrg(); // bootstraps org + 150 trial credits
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const full_name = String(body.full_name ?? "").trim();
  const business_name = String(body.business_name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!full_name || !business_name) return badRequest("name and business are required");

  const user = await getUser();
  const phone = user?.phone ? `+${user.phone}` : "";

  // 1) persist to the auth user — identity everywhere (incl. the WhatsApp assistant)
  const supabase = await createClient();
  const meta = { full_name, business_name, profile_complete: true };
  try {
    if (email && email !== (user?.email ?? "").toLowerCase()) {
      // setting a new email sends a branded confirmation; lets them also sign in by email
      await supabase.auth.updateUser({ email, data: meta });
    } else {
      await supabase.auth.updateUser({ data: meta });
    }
  } catch {
    // metadata is best-effort — never fail the whole bootstrap on it
  }

  // 2) name the org from the business + stash owner contact for delivery + WhatsApp match
  const svc = createServiceClient();
  try {
    const { data: orgRow } = await svc
      .from("organization")
      .select("settings")
      .eq("id", auth.orgId)
      .maybeSingle();
    const settings = ((orgRow?.settings as Record<string, unknown>) ?? {});
    const ownerProfile = {
      full_name,
      phone,
      email: email || user?.email || null,
      updatedAt: new Date().toISOString(),
    };
    await svc
      .from("organization")
      .update({ name: business_name, settings: { ...settings, ownerProfile } })
      .eq("id", auth.orgId);
  } catch {
    // non-fatal — org already exists; a rename/contact stash failing shouldn't block onboarding
  }

  void logEvent("profile_completed", { hasPhone: !!phone }, { orgId: auth.orgId, path: "/welcome" });
  return NextResponse.json({ ok: true, orgId: auth.orgId });
}
