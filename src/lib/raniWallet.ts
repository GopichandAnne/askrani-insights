import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Shared-wallet client — the Insights side of "one account, one wallet".
 *
 * Rani is the billing hub: each store has ONE credit wallet its chatbot debits.
 * When an Insights org is LINKED to a Rani store (a workspace carries
 * goals.raniStore — the same slug the ops umbrella uses), that org's monitoring /
 * deep-read / report spends should draw from the SAME wallet, so the whole
 * business runs on one purse. We reach it through the governed `wallet` edge
 * function (shared secret), never the other project's DB.
 *
 * Env-gated: RANI_WALLET_URL + RANI_OPS_SECRET. When unset, or when an org has no
 * explicit Rani-store link, callers fall back to the local per-org ledger
 * (lib/credits.ts) — so standalone Insights accounts are unaffected. The link must
 * be EXPLICIT (goals.raniStore); we never guess a store slug from a name, because
 * this moves money.
 */

const WALLET_URL = () => (process.env.RANI_WALLET_URL || "").replace(/\/$/, "");
const SECRET = () => process.env.RANI_OPS_SECRET || "";

export function sharedWalletConfigured(): boolean {
  return !!(WALLET_URL() && SECRET());
}

export interface WalletSummary {
  balance: number; plan: string; planCredits: number; topupCredits: number;
  status: string; trialGranted: boolean; totalSpent: number; totalCostUsd: number;
}

/** The Rani store slug this org is explicitly linked to, or null. First workspace
 *  under the org that carries goals.raniStore wins. Null ⇒ not umbrella-linked.
 *  Request-cached by orgId — the layout's credits + org paths both resolve this,
 *  so cache() collapses them to one query per navigation. */
export const resolveRaniStore = cache(async (orgId: string): Promise<string | null> => {
  try {
    const svc = createServiceClient();
    const { data } = await svc.from("workspace").select("goals").eq("organization_id", orgId);
    for (const w of data ?? []) {
      const slug = String((w as { goals?: Record<string, unknown> })?.goals?.raniStore ?? "").trim().toLowerCase();
      if (slug) return slug;
    }
  } catch { /* fall through */ }
  return null;
});

async function call(store: string, action: string, extra: Record<string, unknown> = {}): Promise<any | null> {
  if (!sharedWalletConfigured()) return null;
  try {
    const r = await fetch(WALLET_URL(), {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET()}`, "content-type": "application/json" },
      body: JSON.stringify({ store, action, ...extra }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Ask Rani which store this (verified) email OWNS — the email→store join for the
 *  shared-wallet auto-link. Null when the shared wallet is off or there's no match. */
export async function resolveStoreForEmail(email: string | null | undefined): Promise<string | null> {
  if (!sharedWalletConfigured() || !email) return null;
  const j = await call("", "resolve_store", { email: String(email).trim().toLowerCase() });
  return j?.ok && j.store ? String(j.store).trim().toLowerCase() : null;
}

/** Auto-link an Insights org to its Rani store by the owner's VERIFIED email, so a
 *  business that signs into both apps with the same account runs on ONE wallet.
 *  Idempotent + best-effort: no-op when the shared wallet is off, the org is already
 *  linked (never overrides an explicit link), or no Rani store is owned by this
 *  email. Writes goals.raniStore onto the org's workspaces — the same field the
 *  manual link + resolveRaniStore use. Safe because `email` is the caller's OWN
 *  verified auth email (Supabase only sets user.email via OAuth/magic-link, so a
 *  phone-only user has none). Returns the linked slug, or null. */
const LINK_RECHECK_HOURS = 12;

export async function ensureRaniLinkByEmail(orgId: string, email: string | null | undefined): Promise<string | null> {
  if (!sharedWalletConfigured() || !orgId || !email) return null;
  if (await resolveRaniStore(orgId)) return null; // already linked — never override
  try {
    const svc = createServiceClient();
    const { data: rows } = await svc.from("workspace").select("id, goals").eq("organization_id", orgId);
    if (!rows?.length) return null; // nothing to attach the link to yet
    // Throttle: an Insights org with no Rani store (the common standalone case)
    // must not re-poll Rani on every page load. Re-check at most every 12h — enough
    // that an Insights-first user who subscribes to Rani links within the day.
    const lastChecked = Math.max(0, ...rows.map((w: { goals?: Record<string, unknown> | null }) => Date.parse(String(w?.goals?.raniStoreCheckedAt ?? "")) || 0));
    if (lastChecked && Date.now() - lastChecked < LINK_RECHECK_HOURS * 3_600_000) return null;

    const slug = await resolveStoreForEmail(email);
    const checkedAt = new Date().toISOString();
    for (const w of rows) {
      const goals = { ...(((w as { goals?: Record<string, unknown> }).goals) ?? {}), raniStoreCheckedAt: checkedAt, ...(slug ? { raniStore: slug } : {}) };
      await svc.from("workspace").update({ goals }).eq("id", (w as { id: string }).id);
    }
    return slug;
  } catch {
    return null;
  }
}

export async function walletBalance(store: string): Promise<WalletSummary | null> {
  const j = await call(store, "balance");
  return j?.ok ? (j as WalletSummary) : null;
}

/** Debit the shared wallet. enforce=true refuses when short (returns ok:false).
 *  Returns null on transport failure so the caller can decide how to degrade. */
export async function walletDebit(
  store: string,
  credits: number,
  reason: string,
  opts: { enforce?: boolean; costUsd?: number; ref?: Record<string, unknown> } = {},
): Promise<{ ok: boolean; balance?: number; reason?: string } | null> {
  const j = await call(store, "debit", {
    credits, reason, enforce: !!opts.enforce, cost_usd: opts.costUsd ?? 0, ref: opts.ref ?? null,
  });
  return j ?? null;
}

/** Add persistent top-up credits (refund / credit-back / promo) to the shared wallet. */
export async function walletGrant(store: string, credits: number, reason: string, ref?: Record<string, unknown>): Promise<boolean> {
  const j = await call(store, "grant", { credits, reason, ref: ref ?? null });
  return !!j?.ok;
}
