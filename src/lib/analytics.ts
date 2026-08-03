import { createServiceClient } from "@/lib/supabase/server";

/**
 * First-party product analytics — cookieless, server-side. We log funnel
 * milestones ourselves so the numbers are ours (no third party, no consent
 * needed). Every write is best-effort: analytics must never break a request,
 * and it silently no-ops until the analytics_event table exists (migration 0004).
 */

export type AnalyticsEvent =
  | "explore_search"
  | "signup"
  | "workspace_created"
  | "collect_started";

export async function logEvent(
  event: AnalyticsEvent,
  props: Record<string, unknown> = {},
  opts: { orgId?: string; path?: string } = {},
): Promise<void> {
  try {
    const svc = createServiceClient();
    await svc.from("analytics_event").insert({
      event,
      path: opts.path ?? null,
      org_id: opts.orgId ?? null,
      props,
    });
  } catch {
    /* table missing / transient — analytics is never load-bearing */
  }
}

export interface AnalyticsSummary {
  ok: boolean;
  totals: Record<string, number>;   // event → count (last `days`)
  daily: { date: string; explore: number; signups: number }[]; // funnel over time
  recentSearches: { keyword: string; area: string; at: string }[];
}

/** Roll up the last `days` of events for the admin dashboard. */
export async function analyticsSummary(days = 30): Promise<AnalyticsSummary> {
  const empty: AnalyticsSummary = { ok: false, totals: {}, daily: [], recentSearches: [] };
  try {
    const svc = createServiceClient();
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { data, error } = await svc
      .from("analytics_event")
      .select("event,props,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) return empty;
    const rows = data ?? [];

    const totals: Record<string, number> = {};
    const byDay = new Map<string, { explore: number; signups: number }>();
    const recentSearches: AnalyticsSummary["recentSearches"] = [];
    for (const r of rows) {
      const ev = r.event as string;
      totals[ev] = (totals[ev] ?? 0) + 1;
      const day = String(r.created_at).slice(0, 10);
      const d = byDay.get(day) ?? { explore: 0, signups: 0 };
      if (ev === "explore_search") d.explore++;
      if (ev === "signup") d.signups++;
      byDay.set(day, d);
      if (ev === "explore_search" && recentSearches.length < 20) {
        const p = (r.props as any) ?? {};
        recentSearches.push({ keyword: p.keyword ?? "", area: p.area ?? "", at: String(r.created_at) });
      }
    }
    const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
    return { ok: true, totals, daily, recentSearches };
  } catch {
    return empty;
  }
}
