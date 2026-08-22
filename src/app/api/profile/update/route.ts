import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";

/**
 * Update the owner's profile after first-run — name and, crucially, the contact
 * PHONE NUMBER. The phone is stored on organization.settings.ownerProfile.phone,
 * the same hook the WhatsApp assistant matches an owner on. We deliberately do NOT
 * touch the auth sign-in phone (that needs an OTP re-verification) and we send
 * nothing over WhatsApp here — this just captures/keeps the number current so it's
 * ready when WhatsApp is switched on later.
 */
function normalizePhone(raw: unknown): { ok: boolean; value?: string } {
  const t = String(raw ?? "").trim();
  if (!t) return { ok: true, value: "" }; // clearing the number is allowed
  const digits = t.replace(/[^\d+]/g, "");
  const e164 = digits.startsWith("+") ? digits : `+${digits}`;
  if (!/^\+\d{7,15}$/.test(e164)) return { ok: false };
  return { ok: true, value: e164 };
}

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

  // best-effort: keep the display name on the auth user in sync (never blocks)
  if (full_name) {
    try { const sb = await createClient(); await sb.auth.updateUser({ data: { full_name } }); } catch { /* non-fatal */ }
  }

  void logEvent("profile_updated", { hasPhone: !!ownerProfile.phone }, { orgId: auth.orgId, path: "/billing" });
  return NextResponse.json({ ok: true, ownerProfile });
}
