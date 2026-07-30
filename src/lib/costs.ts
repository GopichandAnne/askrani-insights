import { createServiceClient } from "@/lib/supabase/server";

/**
 * Monitoring cost accounting (guide §16.1 / §16.3). Every collection pass records
 * a `provider_run` row with the real (or estimated) `cost_usd` per source. This
 * module rolls those up per workspace so an owner can see what watching their
 * market actually costs — total, by source, and projected per monitored business.
 *
 * provider_run has no business_id column; startRun() encodes it as the first
 * segment of input_hash (`${businessId}:${provider}:${ts}`), so we recover scope
 * by prefix. Volume is tiny (a handful of runs per business per scan).
 */

export interface ProviderCost {
  provider: string;
  runs: number;
  items: number;
  costUsd: number;
}
export interface BusinessCost {
  businessId: string;
  name: string;
  runs: number;
  costUsd: number;
}
export interface CostSummary {
  days: number;
  runs: number;
  totalUsd: number;
  byProvider: ProviderCost[];
  byBusiness: BusinessCost[];
  monitoredBusinesses: number;
  projectedMonthlyUsd: number; // total scaled to a 30-day month
  perBusinessMonthlyUsd: number; // projectedMonthly / monitoredBusinesses
  budgets: { provider: number; ai: number; storage: number };
  budgetUsedFraction: number | null; // projectedMonthly vs the provider+ai budget (null if no budget set)
}

// Human labels + rough unit economics for sources that don't report real cost.
export const SOURCE_LABELS: Record<string, string> = {
  website: "Website & menus",
  google: "Google reviews & photos",
  yelp: "Yelp reviews",
  youtube: "YouTube uploads",
  ai: "AI extraction (Claude)",
  "apify:instagram": "Instagram",
  "apify:facebook": "Facebook",
  "apify:tiktok": "TikTok",
  "apify:doordash": "DoorDash",
  "apify:ubereats": "UberEats",
};

export function labelForProvider(p: string): string {
  return SOURCE_LABELS[p] ?? p;
}

export async function workspaceCostSummary(workspaceId: string, days = 30): Promise<CostSummary> {
  const svc = createServiceClient();

  // 1) businesses in scope: the target + every active competitor
  const { data: ws } = await svc
    .from("workspace")
    .select("target_business_id, budgets")
    .eq("id", workspaceId)
    .maybeSingle();
  const { data: edges } = await svc
    .from("competitor_edge")
    .select("competitor_id")
    .eq("workspace_id", workspaceId)
    .is("active_to", null);

  const ids = new Set<string>();
  if (ws?.target_business_id) ids.add(ws.target_business_id as string);
  for (const e of edges ?? []) ids.add((e as any).competitor_id);

  const budgets = {
    provider: Number((ws?.budgets as any)?.provider ?? 0),
    ai: Number((ws?.budgets as any)?.ai ?? 0),
    storage: Number((ws?.budgets as any)?.storage ?? 0),
  };

  // names for the by-business table
  const nameById = new Map<string, string>();
  if (ids.size) {
    const { data: bizRows } = await svc
      .from("business")
      .select("id, canonical_name")
      .in("id", [...ids]);
    for (const b of bizRows ?? []) nameById.set((b as any).id, (b as any).canonical_name);
  }

  // 2) recent runs, filtered to in-scope businesses by input_hash prefix
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: runs } = await svc
    .from("provider_run")
    .select("provider, result_count, cost_usd, input_hash, started_at")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(10000);

  const scoped = (runs ?? []).filter((r: any) => ids.has(String(r.input_hash ?? "").split(":")[0]));

  const provAcc = new Map<string, ProviderCost>();
  const bizAcc = new Map<string, BusinessCost>();
  let totalUsd = 0;

  for (const r of scoped) {
    const cost = Number((r as any).cost_usd ?? 0) || 0;
    const items = Number((r as any).result_count ?? 0) || 0;
    totalUsd += cost;

    const p = (r as any).provider as string;
    const pc = provAcc.get(p) ?? { provider: p, runs: 0, items: 0, costUsd: 0 };
    pc.runs++;
    pc.items += items;
    pc.costUsd += cost;
    provAcc.set(p, pc);

    const bid = String((r as any).input_hash ?? "").split(":")[0];
    const bc = bizAcc.get(bid) ?? { businessId: bid, name: nameById.get(bid) ?? "—", runs: 0, costUsd: 0 };
    bc.runs++;
    bc.costUsd += cost;
    bizAcc.set(bid, bc);
  }

  const byProvider = [...provAcc.values()].sort((a, b) => b.costUsd - a.costUsd);
  const byBusiness = [...bizAcc.values()].sort((a, b) => b.costUsd - a.costUsd);
  const round = (n: number) => Number(n.toFixed(2));

  const monitoredBusinesses = ids.size;
  const projectedMonthlyUsd = days > 0 ? totalUsd * (30 / days) : 0;
  const perBusinessMonthlyUsd = monitoredBusinesses > 0 ? projectedMonthlyUsd / monitoredBusinesses : 0;
  const monthlyBudget = budgets.provider + budgets.ai;

  return {
    days,
    runs: scoped.length,
    totalUsd: round(totalUsd),
    byProvider: byProvider.map((p) => ({ ...p, costUsd: round(p.costUsd) })),
    byBusiness: byBusiness.map((b) => ({ ...b, costUsd: round(b.costUsd) })),
    monitoredBusinesses,
    projectedMonthlyUsd: round(projectedMonthlyUsd),
    perBusinessMonthlyUsd: round(perBusinessMonthlyUsd),
    budgets,
    budgetUsedFraction: monthlyBudget > 0 ? Number((projectedMonthlyUsd / monthlyBudget).toFixed(3)) : null,
  };
}
