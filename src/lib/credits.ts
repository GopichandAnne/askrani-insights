import { unstable_cache } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { sharedWalletConfigured, resolveRaniStore, walletBalance, walletDebit, walletGrant } from "@/lib/raniWallet";

/**
 * When an org is LINKED to a Rani store (a workspace carries goals.raniStore) and
 * the shared-wallet env is set, credit reads/writes route to the ONE Rani wallet
 * its chatbot also uses — closing the umbrella loop. Otherwise everything below
 * runs on the local per-org ledger, so standalone Insights accounts are unchanged.
 * The link must be EXPLICIT (never a guessed slug) because this moves money.
 */
async function linkedStore(orgId: string): Promise<string | null> {
  if (!sharedWalletConfigured()) return null;
  try { return await resolveRaniStore(orgId); } catch { return null; }
}

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

/** How many days of competitor deal/price history each plan keeps — the deeper
 *  the archive, the sharper the trend/price-change intelligence, so it's a plan
 *  lever. Used to prune stored flyer history and bound the Offers date window. */
export const PLAN_RETENTION_DAYS: Record<string, number> = { free: 14, starter: 30, growth: 90, pro: 180 };
export function retentionDaysForPlan(plan?: string): number {
  return PLAN_RETENTION_DAYS[plan ?? "free"] ?? 14;
}

/** How often the report/digest is pushed to the owner, by plan. Higher tiers get
 *  a daily report; base tiers get it weekly. Used by the digest cron. */
export function cadenceForPlan(plan?: string): "daily" | "weekly" {
  return PLANS[plan ?? "free"]?.cadence === "daily" ? "daily" : "weekly";
}

/** Credits to send the full report on demand (off-cadence). The report is built
 *  from cache (no collection cost), so this is priced as a small convenience — the
 *  way a weekly-plan owner grabs today's report without waiting for Monday. */
export const REPORT_ON_DEMAND_CREDITS = 5;

/** Credits a run costs, from its real USD COGS. 0 for free runs. */
export function creditsForCost(costUsd: number): number {
  if (!(costUsd > 0)) return 0;
  return Math.max(1, Math.ceil(costUsd / CREDIT_COGS_CAP_USD));
}

export interface LedgerEntry { ts: string; delta: number; bucket: "plan" | "topup"; reason: string; costUsd?: number; ref?: Record<string, unknown> }
export interface Billing {
  plan: string;          // 'free' | 'starter' | 'growth' | 'pro'
  planCredits: number;   // resets each period
  topupCredits: number;  // persists (trial + purchased top-ups)
  trialGranted: boolean;
  status: string;
  totalSpent: number;    // lifetime credits spent
  totalCostUsd: number;  // lifetime real COGS
  ledger: LedgerEntry[]; // capped recent history
  processedEvents?: string[]; // Stripe event ids handled (idempotency)
  rev?: number;          // optimistic-concurrency counter (compare-and-swap)
}

const DEFAULT: Billing = { plan: "free", planCredits: 0, topupCredits: 0, trialGranted: false, status: "active", totalSpent: 0, totalCostUsd: 0, ledger: [], rev: 0 };
const LEDGER_CAP = 300;
type Svc = ReturnType<typeof createServiceClient>;

/** Sentinel a mutator returns to abort the write (a deliberate no-op — e.g. the
 *  event was already processed, or the balance is short). */
const BILLING_ABORT = Symbol("billing_abort");
type BillingMutator = (b: Billing) => void | typeof BILLING_ABORT | Promise<void | typeof BILLING_ABORT>;

/**
 * Atomic read-modify-write of the org billing blob, with compare-and-swap on a
 * `rev` counter and retry-on-conflict. Every billing mutation goes through this so
 * concurrent writers can't clobber each other — the exact bug where Stripe fires
 * checkout.session.completed AND invoice.paid within milliseconds (separate
 * serverless calls), and one's stale write reset the plan the other had just set.
 * Returns the new billing, or null if the mutator aborted.
 */
async function mutateBilling(svc: Svc, orgId: string, mutate: BillingMutator): Promise<Billing | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { settings, billing } = await readBilling(svc, orgId);
    const oldRev = billing.rev ?? 0;
    if ((await mutate(billing)) === BILLING_ABORT) return null;
    billing.rev = oldRev + 1;
    billing.ledger = (billing.ledger ?? []).slice(-LEDGER_CAP);
    let q = svc.from("organization").update({ settings: { ...settings, billing } }).eq("id", orgId);
    // CAS: only write if rev is unchanged since our read (first write: null or 0).
    q = oldRev === 0
      ? q.or("settings->billing->>rev.is.null,settings->billing->>rev.eq.0")
      : q.filter("settings->billing->>rev", "eq", String(oldRev));
    const { data } = await q.select("id");
    if (data && data.length) return billing; // applied
    await new Promise((r) => setTimeout(r, 25 + attempt * 40)); // conflict → re-read + retry
  }
  // Last resort (rare): a plain write so a grant is never silently dropped.
  const { settings, billing } = await readBilling(svc, orgId);
  if ((await mutate(billing)) === BILLING_ABORT) return null;
  billing.rev = (billing.rev ?? 0) + 1;
  await writeBilling(svc, orgId, settings, billing);
  return billing;
}

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

/** Current org credit balance. Shared Rani wallet when linked, else local ledger. */
export async function getBalance(orgId: string): Promise<number> {
  const store = await linkedStore(orgId);
  if (store) {
    const w = await walletBalance(store);
    if (w) return w.balance; // else fall through to local (transient wallet error)
  }
  const svc = createServiceClient();
  const { billing } = await readBilling(svc, orgId);
  return balanceOf(billing);
}
/** Does the org have at least `min` credits? (Phase 2 gating.) */
export async function hasCredits(orgId: string, min = 1): Promise<boolean> {
  try { return (await getBalance(orgId)) >= min; } catch { return true; /* fail-open on infra error */ }
}

/**
 * Balance for the NAV credits pill only — cached ~30s per org so navigating
 * between menus never blocks on the balance lookup (which, for an umbrella-linked
 * org, is a cross-project HTTP call to the Rani wallet). A 30s-stale pill is fine;
 * the billing page still calls the live creditsSummary. This keeps every click
 * fast without changing any number's correctness (spends still record exactly).
 */
export function navBalance(orgId: string): Promise<number> {
  return unstable_cache(
    () => getBalance(orgId).catch(() => 0),
    ["nav-credits-balance", orgId],
    { revalidate: 30 },
  )();
}

/** Grant the one-time trial credits on first org bootstrap (idempotent). */
export async function grantTrialIfNeeded(orgId: string): Promise<void> {
  // Linked orgs get their trial on the Rani store wallet (provisioned there on
  // store creation), so there's no separate Insights trial to grant.
  if (await linkedStore(orgId)) return;
  try {
    const svc = createServiceClient();
    await mutateBilling(svc, orgId, (b) => {
      if (b.trialGranted) return BILLING_ABORT;
      b.trialGranted = true;
      b.topupCredits += TRIAL_CREDITS;
      b.ledger.push({ ts: new Date().toISOString(), delta: TRIAL_CREDITS, bucket: "topup", reason: "trial_grant" });
    });
  } catch { /* never block auth on credits */ }
}

/** Record consumption for a finished collection (Phase 1: debits, never blocks). */
export async function spendForCost(orgId: string, costUsd: number, ref: Record<string, unknown>): Promise<void> {
  const credits = creditsForCost(costUsd);
  if (credits <= 0) return;
  const store = await linkedStore(orgId);
  if (store) { await walletDebit(store, credits, "collection", { enforce: false, costUsd, ref }); return; }
  try {
    const svc = createServiceClient();
    await mutateBilling(svc, orgId, (b) => {
      // debit plan credits first, then top-up (may go negative in Phase 1 — record-only)
      let remaining = credits;
      const fromPlan = Math.min(b.planCredits, remaining);
      b.planCredits -= fromPlan;
      remaining -= fromPlan;
      b.topupCredits -= remaining;
      b.totalSpent += credits;
      b.totalCostUsd = Number((b.totalCostUsd + costUsd).toFixed(4));
      b.ledger.push({ ts: new Date().toISOString(), delta: -credits, bucket: fromPlan >= credits ? "plan" : "topup", reason: "collection_debit", costUsd: Number(costUsd.toFixed(4)), ref });
    });
  } catch { /* record-only; never fail collection on credits */ }
}

// ── Deep read (pay-per-scan) — the middle tier between free Explore and Monitor.
// Value-based FLAT pricing (real COGS is ~$0.10 single / ~$0.90 area ⇒ ~90% $-margin;
// the credit price is positioned to protect the Monitor subscription, not cost-plus).
export const DEEP_READ_SINGLE_CREDITS = 20;          // one business, full profile
export const DEEP_READ_AREA_BASE_CREDITS = 20;       // your business
export const DEEP_READ_PER_COMPETITOR_CREDITS = 12;  // each local rival scanned
export const DEEP_READ_COMPETITOR_CAP = 10;          // quote cap so it can't run away

/** Credits a deep read costs. Single = flat; area = base + per-competitor (capped). */
export function quoteDeepRead(scope: "single" | "area", competitorCount = 0): number {
  if (scope === "single") return DEEP_READ_SINGLE_CREDITS;
  return DEEP_READ_AREA_BASE_CREDITS + DEEP_READ_PER_COMPETITOR_CREDITS * Math.min(competitorCount, DEEP_READ_COMPETITOR_CAP);
}

// ── Area monitoring — the up-front price to START watching a whole area (no
// business of your own). Scales with how many businesses we watch there (the
// "credits scale with how much we collect" model). Priced a touch under a repeat
// area deep read so ongoing monitoring is the better deal; each weekly refresh
// then debits real COGS via spendForCost, like any monitored workspace.
export const AREA_MONITOR_BASE_CREDITS = 20;         // the area scan itself
export const AREA_MONITOR_PER_BUSINESS_CREDITS = 10; // each business watched
export const AREA_MONITOR_BUSINESS_CAP = 12;         // quote cap (we watch ≤15)

/** Credits to start monitoring an area = base + per-business (capped). */
export function quoteAreaMonitor(businessCount = 0): number {
  return AREA_MONITOR_BASE_CREDITS + AREA_MONITOR_PER_BUSINESS_CREDITS * Math.min(Math.max(0, businessCount), AREA_MONITOR_BUSINESS_CAP);
}

// ── Flyer read — scrape rivals' Instagram fresh, download the sale-flyer images,
// and vision-read the printed prices. Cost-bearing (Apify scrape + vision), so it's
// an explicit, credit-charged action (refunded if no flyers are found).
export const FLYER_READ_BASE_CREDITS = 15;
export const FLYER_READ_PER_COMPETITOR_CREDITS = 8;
export const FLYER_READ_COMPETITOR_CAP = 6;

/** Credits to read rivals' sale flyers = base + per-competitor (capped). */
export function quoteFlyerRead(competitorCount = 0): number {
  return FLYER_READ_BASE_CREDITS + FLYER_READ_PER_COMPETITOR_CREDITS * Math.min(Math.max(0, competitorCount), FLYER_READ_COMPETITOR_CAP);
}

/** Charge an explicit credit amount for a discrete action (deep read). Debits plan
 *  first then top-up. Returns false without charging if the balance is short. */
export async function spendCredits(orgId: string, credits: number, reason: string, ref?: Record<string, unknown>): Promise<boolean> {
  if (!(credits > 0)) return true;
  const store = await linkedStore(orgId);
  if (store) {
    const r = await walletDebit(store, credits, reason, { enforce: true, ref });
    // Fail CLOSED on a transport error: never grant a paid action without charging.
    return r ? r.ok : false;
  }
  const svc = createServiceClient();
  const result = await mutateBilling(svc, orgId, (b) => {
    if (balanceOf(b) < credits) return BILLING_ABORT; // insufficient → no charge
    let remaining = credits;
    const fromPlan = Math.min(b.planCredits, remaining);
    b.planCredits -= fromPlan;
    remaining -= fromPlan;
    b.topupCredits -= remaining;
    b.totalSpent += credits;
    b.ledger.push({ ts: new Date().toISOString(), delta: -credits, bucket: fromPlan >= credits ? "plan" : "topup", reason, ref });
  });
  return result !== null;
}

/** Credit back a prior charge (deep-read → Monitor promotion within the window). */
export async function refundCredits(orgId: string, credits: number, reason: string, ref?: Record<string, unknown>): Promise<void> {
  if (!(credits > 0)) return;
  const store = await linkedStore(orgId);
  if (store) { await walletGrant(store, credits, reason, ref); return; }
  const svc = createServiceClient();
  await mutateBilling(svc, orgId, (b) => {
    b.topupCredits += credits;                    // refunds land in the persistent bucket
    b.totalSpent = Math.max(0, b.totalSpent - credits);
    b.ledger.push({ ts: new Date().toISOString(), delta: credits, bucket: "topup", reason, ref });
  });
}

export interface CreditsSummary {
  balance: number; plan: string; status: string; planCredits: number; topupCredits: number;
  totalSpent: number; totalCostUsd: number; trialGranted: boolean;
  recent: LedgerEntry[];
}
export async function creditsSummary(orgId: string): Promise<CreditsSummary> {
  const store = await linkedStore(orgId);
  if (store) {
    const w = await walletBalance(store);
    if (w) {
      return {
        balance: w.balance, plan: w.plan, status: w.status, planCredits: w.planCredits,
        topupCredits: w.topupCredits, totalSpent: w.totalSpent, totalCostUsd: w.totalCostUsd,
        trialGranted: w.trialGranted, recent: [], // shared-wallet ledger detail exposed later
      };
    }
  }
  const svc = createServiceClient();
  const { billing } = await readBilling(svc, orgId);
  return {
    balance: balanceOf(billing),
    plan: billing.plan ?? "free",
    status: billing.status ?? "active",
    planCredits: billing.planCredits,
    topupCredits: billing.topupCredits,
    totalSpent: billing.totalSpent,
    totalCostUsd: billing.totalCostUsd,
    trialGranted: billing.trialGranted,
    recent: billing.ledger.slice(-25).reverse(),
  };
}

/** Read the org's plan (from billing; used by the scheduler for cadence). */
export async function planOfOrg(orgId: string): Promise<string> {
  const store = await linkedStore(orgId);
  if (store) { const w = await walletBalance(store); if (w) return w.plan; }
  const svc = createServiceClient();
  const { billing } = await readBilling(svc, orgId);
  return billing.plan ?? "free";
}

// ── Stripe-driven grants (Phase 3). Called from the webhook (low frequency). ──

/** One-time top-up: add persistent credits. */
export async function grantTopup(orgId: string, credits: number, ref?: Record<string, unknown>): Promise<void> {
  const svc = createServiceClient();
  await mutateBilling(svc, orgId, (b) => {
    b.topupCredits += credits;
    b.ledger.push({ ts: new Date().toISOString(), delta: credits, bucket: "topup", reason: "topup_purchase", ref });
  });
}

/** Set the active plan + status (no credit change; grant happens on invoice.paid). */
export async function setPlan(orgId: string, plan: string, status = "active"): Promise<void> {
  const svc = createServiceClient();
  await mutateBilling(svc, orgId, (b) => { b.plan = plan; b.status = status; });
}

/** Reset the monthly plan-credit allotment (subscription first payment + renewals). */
export async function grantPlanCredits(orgId: string): Promise<void> {
  const svc = createServiceClient();
  await mutateBilling(svc, orgId, (b) => {
    const grant = PLANS[b.plan]?.monthlyCredits ?? 0;
    b.planCredits = grant; // reset, not accumulate (use-it-or-lose-it)
    b.ledger.push({ ts: new Date().toISOString(), delta: grant, bucket: "plan", reason: "period_reset" });
  });
}

/** Idempotency: returns true the first time an event id is seen for the org. */
export async function markEventProcessed(orgId: string, eventId: string): Promise<boolean> {
  const svc = createServiceClient();
  const result = await mutateBilling(svc, orgId, (b) => {
    const seen = b.processedEvents ?? [];
    if (seen.includes(eventId)) return BILLING_ABORT;
    b.processedEvents = [...seen, eventId].slice(-100);
  });
  return result !== null;
}

/** Store the Stripe customer id on the org (column) + find org by it. */
export async function setStripeCustomer(orgId: string, customerId: string): Promise<void> {
  const svc = createServiceClient();
  await svc.from("organization").update({ billing_customer_id: customerId }).eq("id", orgId);
}
export async function orgByStripeCustomer(customerId: string): Promise<string | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("organization").select("id").eq("billing_customer_id", customerId).maybeSingle();
  return (data?.id as string) ?? null;
}
export async function getStripeCustomer(orgId: string): Promise<string | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("organization").select("billing_customer_id").eq("id", orgId).maybeSingle();
  return (data?.billing_customer_id as string) ?? null;
}
