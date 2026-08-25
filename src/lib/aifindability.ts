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
// Shared instruction for the search-grounded engines (free-text answer).
const ENGINE_SYSTEM =
  "You are a local-recommendations assistant — the kind of AI a customer asks when deciding where to go. For the user's question, recommend the specific, real local businesses you'd actually suggest, best first, naming each one explicitly. Only real businesses that exist in that area.";

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

const QUESTIONS_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { questions: { type: "array", maxItems: 10, items: { type: "string" } } },
  required: ["questions"],
};
const QUESTIONS_SYSTEM =
  "You rewrite short local-search keywords into the NATURAL, conversational questions a real person actually asks an AI assistant (ChatGPT, Perplexity) when deciding where to go. Keep the location. Add the realistic constraints people really mention — 'open now', 'that delivers to <town>', 'good for a birthday', 'does catering for 30', 'vegetarian', 'halal', 'best'. Each is one natural question, first person. Return about 8, varied.";

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

// ── engines ─────────────────────────────────────────────────────────────────
// Each engine asks one question and returns the answer text (null on failure).
// These are the SEARCH-GROUNDED assistants people actually use — their answers
// reflect live local results. Add Google AI Overviews (via a SERP provider) or
// Gemini the same way; they just append to the engine list.
interface EngineResult { engine: string; text: string }
type EngineFn = (q: string) => Promise<EngineResult | null>;

/** Perplexity Sonar (PERPLEXITY_API_KEY). */
async function perplexityAsk(q: string): Promise<EngineResult | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.PERPLEXITY_MODEL || "sonar", max_tokens: 500, messages: [{ role: "system", content: ENGINE_SYSTEM }, { role: "user", content: q }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { engine: "Perplexity", text: String(d?.choices?.[0]?.message?.content ?? "") };
  } catch { return null; }
}

/** ChatGPT with web search (OPENAI_API_KEY) — a search-grounded model does the
 *  browsing. Model is overridable via OPENAI_SEARCH_MODEL if the name changes. */
async function chatgptAsk(q: string): Promise<EngineResult | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_SEARCH_MODEL || "gpt-4o-search-preview";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: ENGINE_SYSTEM }, { role: "user", content: q }] }),
      signal: AbortSignal.timeout(40000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { engine: "ChatGPT", text: String(d?.choices?.[0]?.message?.content ?? "") };
  } catch { return null; }
}

/** Knowledge-only fallback (Claude) — used ONLY when no search engine is keyed.
 *  It can't browse, so it rarely knows small local shops → the scan reports empty. */
async function knowledgeAsk(q: string): Promise<EngineResult | null> {
  try {
    const { data } = await getLlm().callStructured<{ businesses: { name: string }[] }>({
      system: SYSTEM, text: `Customer search: "${q}". List the specific local businesses you'd recommend, best first.`,
      schema: SCHEMA, tier: "extract", maxTokens: 400,
    });
    const name = getLlm().provider === "anthropic" ? "Claude" : getLlm().provider;
    return { engine: name, text: (Array.isArray(data.businesses) ? data.businesses : []).map((b) => String(b.name ?? "")).join("\n") };
  } catch { return null; }
}

/** The search-grounded engines currently configured (by env keys). */
function searchEngines(): EngineFn[] {
  const list: EngineFn[] = [];
  if (process.env.PERPLEXITY_API_KEY) list.push(perplexityAsk);
  if (process.env.OPENAI_API_KEY) list.push(chatgptAsk);
  return list;
}

/** Turn the tracked findability keywords into the natural questions a person
 *  really asks an AI — grounded in the same terms, but conversational and
 *  constraint-rich. Falls back to the raw terms if the rewrite is unavailable. */
async function buildQuestions(ws: WorkspaceRow, goals: Record<string, any>, max: number): Promise<string[]> {
  const terms = ((goals.findability?.keywords ?? []) as { term?: string }[]).map((k) => String(k.term ?? "").trim()).filter(Boolean);
  const seeds = [...new Set(terms)].slice(0, 12);
  if (!seeds.length || !isLlmConfigured()) return seeds.slice(0, max);
  try {
    const { data } = await getLlm().callStructured<{ questions: string[] }>({
      system: QUESTIONS_SYSTEM,
      text: `Business type: ${ws.vertical}.\nRewrite these local searches as natural questions someone would ask an AI assistant:\n${seeds.join("\n")}`,
      schema: QUESTIONS_SCHEMA, tier: "classify", maxTokens: 700,
    });
    const qs = (data?.questions ?? []).map((s) => String(s).trim()).filter((s) => s.length > 8);
    return (qs.length ? qs : seeds).slice(0, max);
  } catch { return seeds.slice(0, max); }
}

/** Run the AI-findability scan across every configured engine and persist
 *  goals.aiFindability. Score = prominence-weighted mention rate over
 *  (question × engine) samples — so it reflects how MULTIPLE AIs answer REAL
 *  conversational questions, not one model on a short keyword. */
export async function refreshAiFindability(ws: WorkspaceRow, opts: { maxQueries?: number } = {}): Promise<AiFindabilityReport> {
  const at = new Date().toISOString();
  const svc = createServiceClient();
  const { data: wRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (wRow?.goals ?? {}) as Record<string, any>;

  // conversational questions, grounded in the tracked findability keywords
  const questions = await buildQuestions(ws, goals, opts.maxQueries ?? 8);
  if (!questions.length) return { score: 0, byBiz: {}, competitorsRecommended: [], engines: [], queries: 0, at, empty: true };

  // known businesses to detect: target + competitors
  const { data: edges } = await svc
    .from("competitor_edge")
    .select("competitor:competitor_id(canonical_name)")
    .eq("workspace_id", ws.id);
  const known = new Map<string, string>(); // normName → display
  known.set(normName(ws.name), ws.name);
  for (const e of edges ?? []) { const n = (e.competitor as any)?.canonical_name; if (n) known.set(normName(n), n); }

  // engines: all keyed search-grounded assistants; else the knowledge-only fallback
  const engines = searchEngines();
  const grounded = engines.length > 0;
  const engineList: EngineFn[] = grounded ? engines : [knowledgeAsk];

  // ask every question on every engine; scan each answer (order = prominence)
  const contrib = new Map<string, number[]>();
  const enginesUsed = new Set<string>();
  let hadAnswer = false;
  for (const q of questions) {
    for (const ask of engineList) {
      const res = await ask(q);
      if (!res || !res.text.trim()) continue;
      hadAnswer = true;
      enginesUsed.add(res.engine);
      const lower = res.text.toLowerCase();
      const found = [...known].map(([k, name]) => ({ k, idx: bizIndex(lower, name) })).filter((f) => f.idx >= 0).sort((a, b) => a.idx - b.idx);
      const seen = new Set<string>();
      found.forEach((f, pos) => { (contrib.get(f.k) ?? contrib.set(f.k, []).get(f.k)!).push(weight(pos)); seen.add(f.k); });
      for (const k of known.keys()) if (!seen.has(k)) (contrib.get(k) ?? contrib.set(k, []).get(k)!).push(0);
    }
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

  // Empty = no search-grounded engine configured, or none returned an answer. A
  // knowledge-only model can't know small local shops, so we mark empty rather than
  // show a misleading flat zero. Lights up the moment a search engine key is set.
  const empty = !grounded || !hadAnswer;
  const report: AiFindabilityReport = {
    score: targetScore, byBiz, competitorsRecommended,
    engines: [...enginesUsed],
    queries: questions.length, at,
    ...(empty ? { empty: true } : {}),
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
