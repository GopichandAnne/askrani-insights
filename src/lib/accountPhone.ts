import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Account phone helpers. The account's phone lives in TWO places, on purpose:
 *   • auth.users.phone (digits, no "+") — the sign-in identity AND the number the
 *     WhatsApp↔web bridge (conversation.ts resolveWaParticipant) matches a person
 *     on, so their WhatsApp and web assistant threads unify.
 *   • organization.settings.ownerProfile.phone ("+"-prefixed E.164) — the owner's
 *     contact/notify number.
 * "A phone on every account" means landing the number on the AUTH identity, which
 * is what these helpers do (setAccountPhone), in addition to the contact profile.
 */

/** E.164 normalize → { ok, value }. Blank is allowed (ok, ""): clearing a number. */
export function normalizePhone(raw: unknown): { ok: boolean; value?: string } {
  const t = String(raw ?? "").trim();
  if (!t) return { ok: true, value: "" };
  const digits = t.replace(/[^\d+]/g, "");
  const e164 = digits.startsWith("+") ? digits : `+${digits}`;
  if (!/^\+\d{7,15}$/.test(e164)) return { ok: false };
  return { ok: true, value: e164 };
}

type Svc = ReturnType<typeof createServiceClient>;

/**
 * Set the account's AUTH identity phone (auth.users.phone). Uses the admin API
 * with phone_confirm so it needs NO SMS OTP round-trip (same pattern as team.ts
 * createUser) — the owner just types their number. Supabase enforces phone
 * uniqueness across accounts, so a number already claimed by another account
 * returns { ok:false } with a reason; the caller then keeps the contact number on
 * ownerProfile + sets the phone_captured flag and never hard-fails on this (which
 * would otherwise lock a user out behind the backfill gate).
 */
export async function setAccountPhone(svc: Svc, userId: string, e164: string): Promise<{ ok: boolean; reason?: string }> {
  if (!/^\+\d{7,15}$/.test(e164)) return { ok: false, reason: "invalid" };
  try {
    const { error } = await (svc as any).auth.admin.updateUserById(userId, { phone: e164, phone_confirm: true });
    if (error) return { ok: false, reason: (error as { message?: string }).message ?? "update failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
