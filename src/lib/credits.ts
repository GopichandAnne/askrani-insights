import { createServiceClient } from "@/lib/supabase/server";

/**
 * Credits — Phase 1 (record-only, no gating).
 *
 * Monitoring consumes credits; plans/top-ups grant them. Phase 1 records real
 * consumption so we can calibrate pricing before turning on gating (Phase 2) and
 * Stripe (Phase 3). To avoid a DB migration now, the ledger + balance live in
 * `organization.settings.billing` (same pattern as workspace.goals caching).
 * When we add gating/Stripe we'll migrate this to dedicated tables + an atomic
 * RPC; for record-only observation, read-modify-write is acceptable.
 */

/** Real COGS one credit is allowed to cover (grounded in provider_run averages:
 *  a full business refresh ≈ $0.05–0.08 ⇒ ~3 credits). */
export const CREDIT_COGS_CAP_USD = 0.02;
export const TRIAL_CREDITS = 150;

/** Plan → monthly credit grant + caps (used from Phase 2; here for reference). */
export const PLANS: Record<string, { label: string; priceUsd: number; monthlyCredits: number; businessCap: number; cadence: string }> = {
  free: { label: "Free", priceUsd: 0, monthlyCredits: 0, businessCap: 1, cadence: "weekly" },
  starter: { label: "Starter", priceUsd: 39, monthlyCredits: 500, businessCap: 10, cadence: "weekly" },
  growth: { label: "Growth", priceUsd: 129, monthlyCredits: 2000, businessCap: 30, cadence: "daily" },
  pro: { label: "Pro", priceUsd: 349, monthlyCredits: 6000, businessCap: 100, cadence: "daily" },
};

/** Credits a run costs, from its real USD COGS. 0 for free runs. */
export function creditsForCost(costUsd: number): number {
  if (!(costUsd > 0)) return 0;
  return Math.max(1, Math.ceil(costUsd / CREDIT_COGS_CAP_USD));
}

export interface LedgerEntry { ts: string; delta: number; bucket: "plan" | "topup"; reason: string; costUsd?: number; ref?: Record<string, unknown> }
export interface Billing {
  planCredits: number;   // resets each period (Phase 2+)
  topupCredits: number;  // persists (trial + purchased top-ups)
  trialGranted: boolean;
  status: string;
  totalSpent: number;    // lifetime credits spent
  totalCostUsd: number;  // lifetime real COGS
  ledger: LedgerEntry[]; // capped recent history (full ledger → table in Phase 3)
}

const DEFAULT: Billing = { planCredits: 0, topupCredits: 0, trialGranted: false, status: "active", totalSpent: 0, totalCostUsd: 0, ledger: [] };
const LEDGER_CAP = 300;
type Svc = ReturnType<typeof createServiceClient>;

async function readBilling(svc: Svc, orgId: string): Promise<{ settings: Record<string, unknown>; billing: Billing }> {
  const { data } = await svc.from("organization").select("settings").eq("id", orgId).maybeSingle();
  const settings = ((data?.settings as Record<string, unknown>) ?? {});
  const billing = { ...DEFAULT, ...((settings.billing as Partial<Billing>) ?? {}) };
  billing.ledger = Array.isArray(billing.ledger) ? billing.ledger : [];
  return { settings, billing };
}
async function writeBilling(svc: Svc, orgId: string, settings: Record<string, unknown>, billing: Billing) {
  billing.ledger = billing.ledger.slice(-LEDGER_CAP);
  await svc.from("organization").update({ settings: { ...settings, billing } }).eq("id", orgId);
}

export function balanceOf(b: Billing): number { return b.planCredits + b.topupCredits; }

/** Current org credit balance. */
export async function getBalance(orgId: string): Promise<number> {
  const svc = createServiceClient();
  const { billing } = await readBilling(svc, orgId);
  return balanceOf(billing);
}
/** Does the org have at least `min` credits? (Phase 2 gating.) */
export async function hasCredits(orgId: string, min = 1): Promise<boolean> {
  try { return (await getBalance(orgId)) >= min; } catch { return true; /* fail-open on infra error */ }
}

/** Grant the one-time trial credits on first org bootstrap (idempotent). */
export async function grantTrialIfNeeded(orgId: string): Promise<void> {
  try {
    const svc = createServiceClient();
    const { settings, billing } = await readBilling(svc, orgId);
    if (billing.trialGranted) return;
    billing.trialGranted = true;
    billing.topupCredits += TRIAL_CREDITS;
    billing.ledger.push({ ts: new Date().toISOString(), delta: TRIAL_CREDITS, bucket: "topup", reason: "trial_grant" });
    await writeBilling(svc, orgId, settings, billing);
  } catch { /* never block auth on credits */ }
}

/** Record consumption for a finished collection (Phase 1: debits, never blocks). */
export async function spendForCost(orgId: string, costUsd: number, ref: Record<string, unknown>): Promise<void> {
  const credits = creditsForCost(costUsd);
  if (credits <= 0) return;
  try {
    const svc = createServiceClient();
    const { settings, billing } = await readBilling(svc, orgId);
    // debit plan credits first, then top-up (may go negative in Phase 1 — record-only)
    let remaining = credits;
    const fromPlan = Math.min(billing.planCredits, remaining);
    billing.planCredits -= fromPlan;
    remaining -= fromPlan;
    billing.topupCredits -= remaining;
    billing.totalSpent += credits;
    billing.totalCostUsd = Number((billing.totalCostUsd + costUsd).toFixed(4));
    billing.ledger.push({ ts: new Date().toISOString(), delta: -credits, bucket: fromPlan >= credits ? "plan" : "topup", reason: "collection_debit", costUsd: Number(costUsd.toFixed(4)), ref });
    await writeBilling(svc, orgId, settings, billing);
  } catch { /* record-only; never fail collection on credits */ }
}

export interface CreditsSummary {
  balance: number; planCredits: number; topupCredits: number;
  totalSpent: number; totalCostUsd: number; trialGranted: boolean;
  recent: LedgerEntry[];
}
export async function creditsSummary(orgId: string): Promise<CreditsSummary> {
  const svc = createServiceClient();
  const { billing } = await readBilling(svc, orgId);
  return {
    balance: balanceOf(billing),
    planCredits: billing.planCredits,
    topupCredits: billing.topupCredits,
    totalSpent: billing.totalSpent,
    totalCostUsd: billing.totalCostUsd,
    trialGranted: billing.trialGranted,
    recent: billing.ledger.slice(-25).reverse(),
  };
}
