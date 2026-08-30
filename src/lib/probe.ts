import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Answer-engine probe — the receipts behind Proof B. We ask a LIVE-retrieval
 * engine (Perplexity: reads the web at answer-time, returns citations) a real
 * customer question ABOUT a specific business, capture the verbatim answer +
 * whether it actually answered and whether it cited the business's own site or
 * its Ask Rani Answers page. Run before publish (engine shrugs) and after
 * (engine answers + cites) → an evidenced, dated before→after.
 *
 * Env-gated: no PERPLEXITY_API_KEY → returns null (feature dormant, caller shows
 * "connect an engine"). Perplexity chosen because it reads Bing/live web, which
 * IndexNow refreshes in minutes — the fast path our Answers page targets.
 */

export interface ProbeResult {
  question: string;
  engine: string;
  answer: string;
  citations: string[];
  answered: boolean; // did it actually answer with specifics (vs. "I don't know")
  citedOwn: boolean; // cited the business site or its Answers page
  at: string; // ISO timestamp — the receipt
}

const ANSWERED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answered: { type: "boolean" } },
  required: ["answered"],
};

function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

async function askPerplexity(
  name: string,
  siteUrl: string | undefined,
  question: string,
): Promise<{ answer: string; citations: string[] } | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const sys =
    "You answer questions about a specific business using live web sources. If you cannot find specific information about THIS business, say so plainly rather than guessing.";
  const who = siteUrl ? `the business "${name}" (${siteUrl})` : `the business "${name}"`;
  const user = `About ${who}: ${question}`;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.PERPLEXITY_MODEL || "sonar",
        messages: [
          { role: "system", content: sys },
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

  const out: ProbeResult[] = [];
  for (const q of input.questions.slice(0, 4)) {
    const at = new Date().toISOString();
    const pr = await askPerplexity(input.name, input.siteUrl, q);
    if (!pr) {
      out.push({ question: q, engine: "perplexity", answer: "", citations: [], answered: false, citedOwn: false, at });
      continue;
    }
    const answered = await isAnswered(q, pr.answer);
    const citedOwn = pr.citations.some((c) => {
      const h = hostOf(c);
      if (siteHost && h === siteHost) return true;
      if (answersPath && answersPath.length > 3 && c.includes(answersPath)) return true;
      return false;
    });
    out.push({
      question: q,
      engine: "perplexity",
      answer: pr.answer.slice(0, 800),
      citations: pr.citations.slice(0, 6),
      answered,
      citedOwn,
      at,
    });
  }
  return out;
}
