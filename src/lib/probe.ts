import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Answer-engine probe — the receipts behind Proof B. Two tiers, because they
 * prove very different things:
 *   • "gap"     — NAMED questions about the business (does the engine answer a
 *                 specific fact, and cite you). Controllable, honest defensive
 *                 proof: before "I don't have that", after answered + cited.
 *   • "context" — NON-BRANDED intent queries a prospect who doesn't know you
 *                 would type ("best DCIM for higher-ed"). The signal is whether
 *                 you get MENTIONED/recommended at all — the discovery win. High
 *                 value, harder to move, so we measure it honestly, never promise.
 *
 * Uses Perplexity (live-retrieval + citations). Env-gated on PERPLEXITY_API_KEY.
 */

export interface ProbeResult {
  question: string;
  kind: "gap" | "context";
  engine: string;
  answer: string;
  citations: string[];
  answered: boolean; // gap: a specific substantive answer was given
  mentioned: boolean; // the business appears (name in answer or domain cited) — the context signal
  citedOwn: boolean; // cited the business site or its Answers page
  competitors?: string[]; // context only — who the engine recommends for these intents
  at: string;
}

const ANSWERED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answered: { type: "boolean" } },
  required: ["answered"],
};

const CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { queries: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 4 } },
  required: ["queries"],
};

const COMPETITORS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { competitors: { type: "array", items: { type: "string" }, maxItems: 8 } },
  required: ["competitors"],
};

/** Who the engine recommends for these non-branded intents (the roadmap of who's
 *  winning the discovery you're missing). One pass over the context answers. */
async function extractCompetitors(name: string, answers: string[]): Promise<string[]> {
  const text = answers.filter(Boolean).join("\n---\n").slice(0, 6000);
  if (!text || !isLlmConfigured()) return [];
  try {
    const { data } = await getLlm().callStructured<{ competitors: string[] }>({
      system:
        `From these AI answers to non-branded queries in a business's category, list the specific companies or PRODUCTS that get recommended — the competitors showing up. EXCLUDE "${name}" itself, review sites (G2, Capterra), and generic terms. Distinct names, most-recommended first.`,
      text,
      schema: COMPETITORS_SCHEMA,
      tier: "classify",
      maxTokens: 150,
    });
    const nameLow = name.toLowerCase();
    return (data.competitors ?? [])
      .map((c) => String(c ?? "").trim())
      .filter((c) => c && c.toLowerCase() !== nameLow)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/** Ask Perplexity a raw prompt; returns the answer text + citation URLs. */
async function askPerplexity(system: string, user: string): Promise<{ answer: string; citations: string[] } | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.PERPLEXITY_MODEL || "sonar",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
    let citations: string[] = Array.isArray(data?.citations)
      ? data.citations.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (!citations.length && Array.isArray(data?.search_results)) {
      citations = data.search_results
        .map((r: { url?: string }) => r?.url)
        .filter((x: unknown): x is string => typeof x === "string");
    }
    return { answer, citations };
  } catch {
    return null;
  }
}

async function isAnswered(question: string, answer: string): Promise<boolean> {
  if (!answer) return false;
  if (!isLlmConfigured()) {
    const low = answer.toLowerCase();
    const shrug = /(don'?t have|do not have|couldn'?t find|could not find|no specific|not able to find|unable to find|no (public )?information|i'm not sure)/;
    return !shrug.test(low) && answer.length > 40;
  }
  try {
    const { data } = await getLlm().callStructured<{ answered: boolean }>({
      system:
        "Decide whether the ASSISTANT RESPONSE actually answers the QUESTION with specific information about the business, versus declining, hedging, or saying it lacks information. Return answered=true ONLY for a specific, substantive answer.",
      text: `QUESTION: ${question}\n\nASSISTANT RESPONSE: ${answer}`,
      schema: ANSWERED_SCHEMA,
      tier: "classify",
      maxTokens: 50,
    });
    return !!data.answered;
  } catch {
    return answer.length > 40;
  }
}

/** Non-branded intent queries a prospect who doesn't know the business would type. */
async function contextQueries(name: string, hints: string[]): Promise<string[]> {
  if (!isLlmConfigured()) return [];
  try {
    const { data } = await getLlm().callStructured<{ queries: string[] }>({
      system:
        "Write 3-4 realistic NON-BRANDED search queries a prospective customer would type into an AI assistant when looking for what this business offers — describe their need, problem, or the product category, and the buyer's context (industry, size) where it helps. NEVER mention the business name or its domain. These test whether the business gets DISCOVERED by people who don't know it yet.",
      text: `BUSINESS: ${name}\nWHAT ITS CUSTOMERS ASK (domain context only): ${hints.slice(0, 6).join(" | ")}`,
      schema: CONTEXT_SCHEMA,
      tier: "classify",
      maxTokens: 200,
    });
    return (data.queries ?? []).map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

export async function probeAnswerEngines(input: {
  name: string;
  siteUrl?: string;
  answersUrl?: string;
  questions: string[];
}): Promise<ProbeResult[] | null> {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  if (!input.name || !input.questions?.length) return [];

  const siteHost = input.siteUrl ? hostOf(input.siteUrl) : "";
  const answersPath = (() => {
    try { return input.answersUrl ? new URL(input.answersUrl).pathname : ""; } catch { return ""; }
  })();
  const nameLow = input.name.toLowerCase();
  const firstWord = input.name.split(/[\s,]+/)[0]?.toLowerCase() ?? nameLow;

  const cites = (citations: string[]) =>
    citations.some((c) => {
      const h = hostOf(c);
      if (siteHost && h === siteHost) return true;
      if (answersPath && answersPath.length > 3 && c.includes(answersPath)) return true;
      return false;
    });
  const names = (answer: string) => {
    const low = answer.toLowerCase();
    return low.includes(nameLow) || (firstWord.length >= 4 && low.includes(firstWord));
  };

  const out: ProbeResult[] = [];

  // Tier 1 — named "gap" probes: does the engine answer a specific fact + cite you.
  const gapSys =
    "You answer questions about a specific business using live web sources. If you cannot find specific information about THIS business, say so plainly rather than guessing.";
  for (const q of input.questions.slice(0, 3)) {
    const at = new Date().toISOString();
    const who = input.siteUrl ? `the business "${input.name}" (${input.siteUrl})` : `the business "${input.name}"`;
    const pr = await askPerplexity(gapSys, `About ${who}: ${q}`);
    if (!pr) {
      out.push({ question: q, kind: "gap", engine: "perplexity", answer: "", citations: [], answered: false, mentioned: false, citedOwn: false, at });
      continue;
    }
    const citedOwn = cites(pr.citations);
    out.push({
      question: q,
      kind: "gap",
      engine: "perplexity",
      answer: pr.answer.slice(0, 800),
      citations: pr.citations.slice(0, 6),
      answered: await isAnswered(q, pr.answer),
      mentioned: names(pr.answer) || citedOwn,
      citedOwn,
      at,
    });
  }

  // Tier 2 — non-branded "context" probes: are you discovered/recommended at all.
  const ctxSys =
    "You help a user find the right product or service for their need. Answer using live web sources and recommend specific companies or products BY NAME where relevant.";
  const ctxQs = await contextQueries(input.name, input.questions);
  for (const q of ctxQs.slice(0, 3)) {
    const at = new Date().toISOString();
    const pr = await askPerplexity(ctxSys, q);
    if (!pr) {
      out.push({ question: q, kind: "context", engine: "perplexity", answer: "", citations: [], answered: false, mentioned: false, citedOwn: false, at });
      continue;
    }
    const citedOwn = cites(pr.citations);
    const mentioned = names(pr.answer) || citedOwn;
    out.push({
      question: q,
      kind: "context",
      engine: "perplexity",
      answer: pr.answer.slice(0, 800),
      citations: pr.citations.slice(0, 6),
      answered: mentioned, // for context, "showing up" is the win
      mentioned,
      citedOwn,
      at,
    });
  }

  // Who's winning these intents — attach to each context row for storage/display.
  const ctxAnswers = out.filter((r) => r.kind === "context").map((r) => r.answer);
  if (ctxAnswers.length) {
    const competitors = await extractCompetitors(input.name, ctxAnswers);
    for (const r of out) if (r.kind === "context") r.competitors = competitors;
  }

  return out;
}

export interface DiscoveryTeaser {
  queries: { query: string; mentioned: boolean }[];
  competitors: string[];
  mentionedCount: number;
  total: number;
}

/** Cheap discovery preview for the PUBLIC grader: 2 non-branded queries — are you
 *  recommended, and who is instead? Bounded to 2 engine calls to cap public cost. */
export async function discoveryTeaser(input: {
  name: string;
  siteUrl?: string;
  hints?: string[];
}): Promise<DiscoveryTeaser | null> {
  if (!process.env.PERPLEXITY_API_KEY || !input.name) return null;
  const ctxQs = await contextQueries(input.name, input.hints ?? []);
  if (!ctxQs.length) return null;

  const siteHost = input.siteUrl ? hostOf(input.siteUrl) : "";
  const nameLow = input.name.toLowerCase();
  const firstWord = input.name.split(/[\s,]+/)[0]?.toLowerCase() ?? nameLow;
  const ctxSys =
    "You help a user find the right product or service for their need. Answer using live web sources and recommend specific companies or products BY NAME where relevant.";

  const answers: string[] = [];
  const queries: { query: string; mentioned: boolean }[] = [];
  for (const q of ctxQs.slice(0, 2)) {
    const pr = await askPerplexity(ctxSys, q);
    const answer = pr?.answer ?? "";
    const cited = (pr?.citations ?? []).some((c) => !!siteHost && hostOf(c) === siteHost);
    const low = answer.toLowerCase();
    const mentioned = cited || low.includes(nameLow) || (firstWord.length >= 4 && low.includes(firstWord));
    queries.push({ query: q, mentioned });
    answers.push(answer);
  }
  const competitors = await extractCompetitors(input.name, answers);
  return { queries, competitors, mentionedCount: queries.filter((q) => q.mentioned).length, total: queries.length };
}
