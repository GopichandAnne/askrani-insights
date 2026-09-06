import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { logEvent } from "@/lib/analytics";
import { normalizePhone, setAccountPhone } from "@/lib/accountPhone";

export const dynamic = "force-dynamic";

/**
 * Update the owner's profile — name and the PHONE NUMBER. The phone is stored two
 * ways: on organization.settings.ownerProfile.phone (contact/notify), AND — when
 * the auth identity has no phone yet — on the AUTH user (auth.users.phone) via the
 * admin API, since that's the number the WhatsApp↔web bridge matches a person on.
 * We only SET the auth phone when it's empty (we don't silently replace a verified
 * sign-in identity here); an already-claimed number just stays as the contact. This
 * is also the write path the phone backfill uses for existing accounts.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const full_name = body.full_name != null ? String(body.full_name).trim() : undefined;

  let phone: string | undefined;
  if (body.phone !== undefined) {
    const n = normalizePhone(body.phone);
    if (!n.ok) return badRequest("Enter a valid phone number with country code, e.g. +1 512 555 0142");
    phone = n.value;
  }

  const user = await getUser();
  const svc = createServiceClient();
  const { data: orgRow } = await svc.from("organization").select("settings").eq("id", auth.orgId).maybeSingle();
  const settings = ((orgRow?.settings as Record<string, unknown>) ?? {});
  const prev = ((settings.ownerProfile as Record<string, unknown>) ?? {});

  const ownerProfile = {
    ...prev,
    full_name: full_name !== undefined ? full_name : (prev.full_name ?? null),
    phone: phone !== undefined ? phone : (prev.phone ?? ""),
    email: prev.email ?? user?.email ?? null,
    updatedAt: new Date().toISOString(),
  };

  await svc.from("organization").update({ settings: { ...settings, ownerProfile } }).eq("id", auth.orgId);

  // Land the number on the AUTH identity if it has none yet — this is what makes an
  // existing account recognized on WhatsApp (the bridge). No SMS round-trip; a
  // number already claimed elsewhere fails silently and just stays as the contact.
  let authPhoneSet = false;
  if (phone && user && !user.phone) {
    const res = await setAccountPhone(svc, user.id, phone);
    authPhoneSet = res.ok;
  }

  // best-effort: keep the display name on the auth user in sync + release the phone
  // backfill gate once a number is on file (even if the auth-phone set was rejected).
  const metaPatch: Record<string, unknown> = {};
  if (full_name) metaPatch.full_name = full_name;
  if (phone) metaPatch.phone_captured = true;
  if (Object.keys(metaPatch).length) {
    try { const sb = await createClient(); await sb.auth.updateUser({ data: metaPatch }); } catch { /* non-fatal */ }
  }

  void logEvent("profile_updated", { hasPhone: !!ownerProfile.phone, authPhoneSet }, { orgId: auth.orgId, path: "/billing" });
  return NextResponse.json({ ok: true, ownerProfile });
}
