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

  // 1) persist name/business to the auth user — this flips profile_complete, which
  //    releases the first-run gate, so it MUST be its own call. Do it first.
  const supabase = await createClient();
  const meta = { full_name, business_name, profile_complete: true };
  try {
    await supabase.auth.updateUser({ data: meta });
  } catch {
    // metadata is best-effort — never fail the whole bootstrap on it
  }

  // 2) OPTIONALLY link the email as a second sign-in identity — separate call,
  //    because it fails when the address already belongs to another account
  //    (e.g. a shared team mailbox). That must NOT block the gate above. The
  //    email is still stored on the owner profile below for digests regardless.
  let emailLinked = true;
  if (email && email !== (user?.email ?? "").toLowerCase()) {
    try {
      await supabase.auth.updateUser({ email }); // sends a branded confirmation
    } catch {
      emailLinked = false;
    }
  }

  // 2) name the org from the business + stash owner contact for delivery + WhatsApp
  //    match — but ONLY for a genuinely new owner. An INVITED teammate already
  //    belongs to the inviter's org (which therefore has >1 member); for them we
  //    must NOT rename the org or overwrite its ownerProfile — just release the
  //    first-run gate (step 1 above already set their personal name).
  const svc = createServiceClient();
  try {
    const { count } = await svc
      .from("org_membership")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", auth.orgId);
    const invitedIntoExistingTeam = (count ?? 1) > 1;
    if (!invitedIntoExistingTeam) {
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
    }
  } catch {
    // non-fatal — org already exists; a rename/contact stash failing shouldn't block onboarding
  }

  void logEvent("profile_completed", { hasPhone: !!phone }, { orgId: auth.orgId, path: "/welcome" });
  return NextResponse.json({ ok: true, orgId: auth.orgId, emailLinked });
}
