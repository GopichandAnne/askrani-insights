import { createServiceClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * AI findability — when a customer asks an AI assistant a real question ("best
 * indian grocery in round rock"), does it recommend YOU, and who does it recommend
 * instead? Reuses the findability customer-query set, asks each answer engine, and
 * scores a prominence-weighted mention rate per business (you + competitors).
 *
 * Provider-pluggable: today it runs against the configured LLM (Claude) — i.e. the
 * AI's own knowledge, which is a real signal (Claude is one of the assistants people
 * ask). Search-grounded engines (Perplexity, ChatGPT-search) slot in as extra
 * "engines" once their keys are set. Report a mention RATE / trend, never an exact
 * rank — AI answers are non-deterministic.
 */

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const round = (n: number) => Math.round(n);

export interface AiBiz { name: string; score: number }
export interface AiFindabilityReport {
  score: number;                                  // the target's 0–100
  byBiz: Record<string, AiBiz>;                   // normName → {name, score}
  competitorsRecommended: { name: string; mentions: number }[];
  engines: string[];
  queries: number;
  at: string;
  empty?: boolean;
}

const SYSTEM =
  "You are a local-recommendations assistant — exactly the kind of AI a customer asks when deciding where to go. Given the customer's search, list the SPECIFIC real local businesses you would actually recommend for it, best first. Only name businesses you genuinely believe exist in that area; if you don't know any specific ones, return an empty list. NEVER invent or guess business names.";

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    businesses: {
      type: "array",
      description: "Specific real local businesses you'd recommend for this search, best first (up to 8). Empty if you don't know any.",
      items: { type: "object", additionalProperties: false, properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  required: ["businesses"],
};

/** Prominence weight for where a business appears in an AI's answer. */
function weight(pos: number): number {
  if (pos < 0) return 0;
  if (pos === 0) return 1;
  if (pos <= 2) return 0.7;
  return 0.45;
}

/** Run the AI-findability scan and persist goals.aiFindability. */
export async function refreshAiFindability(ws: WorkspaceRow, opts: { maxQueries?: number } = {}): Promise<AiFindabilityReport> {
  const at = new Date().toISOString();
  if (!isLlmConfigured()) return { score: 0, byBiz: {}, competitorsRecommended: [], engines: [], queries: 0, at, empty: true };
  const svc = createServiceClient();
  const { data: wRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (wRow?.goals ?? {}) as Record<string, any>;

  // query set — reuse the findability customer terms (they already include the city)
  const terms: string[] = ((goals.findability?.keywords ?? []) as { term?: string }[])
    .map((k) => String(k.term ?? "").trim()).filter(Boolean);
  const queries = [...new Set(terms)].slice(0, opts.maxQueries ?? 8);
  if (!queries.length) return { score: 0, byBiz: {}, competitorsRecommended: [], engines: [], queries: 0, at, empty: true };

  // known businesses to detect: target + competitors
  const { data: edges } = await svc
    .from("competitor_edge")
    .select("competitor:competitor_id(canonical_name)")
    .eq("workspace_id", ws.id);
  const known = new Map<string, string>(); // normName → display
  known.set(normName(ws.name), ws.name);
  for (const e of edges ?? []) { const n = (e.competitor as any)?.canonical_name; if (n) known.set(normName(n), n); }

  // ask each query
  const contrib = new Map<string, number[]>(); // normName → per-query weights
  const otherMentions = new Map<string, { name: string; mentions: number }>();
  for (const q of queries) {
    let names: string[] = [];
    try {
      const { data } = await getLlm().callStructured<{ businesses: { name: string }[] }>({
        system: SYSTEM,
        text: `Customer search: "${q}". List the specific local businesses you'd recommend, best first.`,
        schema: SCHEMA, tier: "extract", maxTokens: 500,
      });
      names = (Array.isArray(data.businesses) ? data.businesses : []).map((b) => String(b.name ?? "").trim()).filter(Boolean);
    } catch { /* skip this query */ }

    const seen = new Set<string>();
    names.forEach((raw, pos) => {
      const key = normName(raw);
      // match to a known business (exact, or contained either way for name variants)
      let matched: string | null = null;
      for (const k of known.keys()) { if (k === key || k.includes(key) || key.includes(k)) { matched = k; break; } }
      if (matched) {
        if (!seen.has(matched)) { (contrib.get(matched) ?? contrib.set(matched, []).get(matched)!).push(weight(pos)); seen.add(matched); }
      } else {
        // a business the AI recommends that isn't in the tracked set
        const e = otherMentions.get(key) ?? { name: raw, mentions: 0 };
        e.mentions++; otherMentions.set(key, e);
      }
    });
    // businesses not mentioned this query score 0 for it
    for (const k of known.keys()) if (!seen.has(k)) (contrib.get(k) ?? contrib.set(k, []).get(k)!).push(0);
  }

  const byBiz: Record<string, AiBiz> = {};
  for (const [k, name] of known) {
    const arr = contrib.get(k) ?? [];
    const score = arr.length ? round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) : 0;
    byBiz[k] = { name, score };
  }
  const targetScore = byBiz[normName(ws.name)]?.score ?? 0;

  const competitorsRecommended = [
    ...[...known].filter(([k]) => k !== normName(ws.name)).map(([k, name]) => ({ name, mentions: (contrib.get(k) ?? []).filter((w) => w > 0).length })).filter((c) => c.mentions > 0),
    ...[...otherMentions.values()],
  ].sort((a, b) => b.mentions - a.mentions).slice(0, 6);

  // No signal = the engine named no local businesses at all (a knowledge-only model
  // that can't browse won't know small local shops). Mark empty so the scorecard
  // shows "no data" rather than a misleading flat-zero comparison. Lights up as soon
  // as a SEARCH-GROUNDED engine (Perplexity / ChatGPT-search / AI Overviews) is added.
  const anyHit = Object.values(byBiz).some((b) => b.score > 0) || competitorsRecommended.length > 0;
  const report: AiFindabilityReport = {
    score: targetScore, byBiz, competitorsRecommended,
    engines: [getLlm().provider === "anthropic" ? "Claude" : getLlm().provider],
    queries: queries.length, at,
    ...(anyHit ? {} : { empty: true }),
  };

  // persist (re-read goals so we don't clobber a concurrent writer)
  const { data: fresh } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((fresh?.goals as object) ?? goals), aiFindability: report } }).eq("id", ws.id);
  return report;
}

/** Cached AI-findability (never scans). */
export async function getAiFindability(ws: WorkspaceRow): Promise<AiFindabilityReport | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  return ((data?.goals as { aiFindability?: AiFindabilityReport } | null)?.aiFindability) ?? null;
}
