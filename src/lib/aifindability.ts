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

// generic tokens that must NOT be used to detect a business in an answer
const GENERIC = new Set(["foods", "market", "bazaar", "grocery", "store", "supermarket", "international", "indian", "farmers", "cedar", "world", "austin", "halal", "durga", "grocers"]);

/** First character index a business is named at in an answer (−1 if absent). Tries
 *  the first two words as a phrase, then distinctive ≥5-char tokens. */
function bizIndex(textLower: string, name: string): number {
  const full = name.toLowerCase();
  const phrase = full.split(/\s+/).slice(0, 2).join(" ");
  if (phrase.length >= 5) { const i = textLower.indexOf(phrase); if (i >= 0) return i; }
  for (const t of full.split(/\W+/)) if (t.length >= 5 && !GENERIC.has(t)) { const j = textLower.indexOf(t); if (j >= 0) return j; }
  return -1;
}

/**
 * Ask ONE answer engine the customer's question and return its answer text.
 * Search-grounded PERPLEXITY when PERPLEXITY_API_KEY is set (this is what makes the
 * scores real — it reflects live local results, like a customer sees); otherwise the
 * knowledge-only default LLM (Claude), which won't know small local shops.
 * Add ChatGPT-search / Google-AI-Overview here the same way for multi-engine reads.
 */
async function askEngine(q: string): Promise<{ engine: string; text: string }> {
  const pk = process.env.PERPLEXITY_API_KEY;
  if (pk) {
    try {
      const r = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${pk}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.PERPLEXITY_MODEL || "sonar",
          max_tokens: 500,
          messages: [
            { role: "system", content: "You are a local-recommendations assistant. For the user's search, recommend the specific real local businesses you'd suggest, best first, naming each one explicitly." },
            { role: "user", content: q },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) { const d = await r.json(); return { engine: "Perplexity", text: String(d?.choices?.[0]?.message?.content ?? "") }; }
    } catch { /* fall through to the knowledge-only engine */ }
  }
  // knowledge-only fallback: structured name list → joined text to scan
  try {
    const { data } = await getLlm().callStructured<{ businesses: { name: string }[] }>({
      system: SYSTEM, text: `Customer search: "${q}". List the specific local businesses you'd recommend, best first.`,
      schema: SCHEMA, tier: "extract", maxTokens: 400,
    });
    return { engine: getLlm().provider === "anthropic" ? "Claude" : getLlm().provider, text: (Array.isArray(data.businesses) ? data.businesses : []).map((b) => String(b.name ?? "")).join("\n") };
  } catch {
    return { engine: getLlm().provider === "anthropic" ? "Claude" : getLlm().provider, text: "" };
  }
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

  // ask each query, scan each answer for the businesses we track (order = prominence)
  const contrib = new Map<string, number[]>(); // normName → per-query weights
  let engineUsed = "";
  for (const q of queries) {
    const { engine, text } = await askEngine(q);
    if (text) engineUsed = engine;
    const lower = text.toLowerCase();
    const found = [...known].map(([k, name]) => ({ k, idx: bizIndex(lower, name) })).filter((f) => f.idx >= 0).sort((a, b) => a.idx - b.idx);
    const seen = new Set<string>();
    found.forEach((f, pos) => { (contrib.get(f.k) ?? contrib.set(f.k, []).get(f.k)!).push(weight(pos)); seen.add(f.k); });
    for (const k of known.keys()) if (!seen.has(k)) (contrib.get(k) ?? contrib.set(k, []).get(k)!).push(0);
  }

  const byBiz: Record<string, AiBiz> = {};
  for (const [k, name] of known) {
    const arr = contrib.get(k) ?? [];
    byBiz[k] = { name, score: arr.length ? round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) : 0 };
  }
  const targetScore = byBiz[normName(ws.name)]?.score ?? 0;

  const competitorsRecommended = [...known].filter(([k]) => k !== normName(ws.name))
    .map(([k, name]) => ({ name, mentions: (contrib.get(k) ?? []).filter((w) => w > 0).length }))
    .filter((c) => c.mentions > 0).sort((a, b) => b.mentions - a.mentions).slice(0, 6);

  // No signal = the engine named no local businesses at all (a knowledge-only model
  // that can't browse won't know small local shops). Mark empty so the scorecard
  // shows "no data" rather than a misleading flat-zero comparison. Lights up as soon
  // as a SEARCH-GROUNDED engine (Perplexity / ChatGPT-search / AI Overviews) is added.
  const anyHit = Object.values(byBiz).some((b) => b.score > 0) || competitorsRecommended.length > 0;
  const report: AiFindabilityReport = {
    score: targetScore, byBiz, competitorsRecommended,
    engines: [engineUsed || (getLlm().provider === "anthropic" ? "Claude" : getLlm().provider)],
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
