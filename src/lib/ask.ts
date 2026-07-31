import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Ask Rani" inline answers — natural-language questions answered over the
 * workspace's own collected data (pricing, reputation, events, recommendations,
 * cost). Grounded: Claude may only use the supplied data and must say when it
 * can't answer, so the command bar never invents numbers.
 */

export interface AskResult {
  answerable: boolean;
  answer: string;
  workspace?: string;
}

const SYSTEM = [
  "You are Ask Rani, a friendly local-market analyst for a busy, non-technical small-business owner.",
  "Answer ONLY from the DATA provided (the owner is \"you\"). Be concise: 1–4 short sentences, plain English, no jargon.",
  "Use specific business names and real numbers from the data. Never invent or estimate figures that aren't present.",
  "If the data doesn't contain the answer, set answerable=false and briefly say what's missing or suggest collecting more.",
  "Prices are in USD. 'offers' means menu items/products. 'events' are recent market changes.",
].join(" ");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answerable: { type: "boolean", description: "true if the DATA supports a real answer" },
    answer: { type: "string", description: "Concise plain-English answer (1–4 sentences)." },
  },
  required: ["answerable", "answer"],
};

export async function answerQuestion(question: string): Promise<AskResult> {
  const q = (question ?? "").trim();
  if (!q) return { answerable: false, answer: "Ask me anything about your market — prices, competitors, ratings, or what to do next." };
  if (!isLlmConfigured()) return { answerable: false, answer: "The assistant isn't configured yet (no AI key)." };

  const state = await activeWorkspace();
  if (state.status !== "ok") {
    return { answerable: false, answer: "Set up your business first, then I can answer questions about your local market." };
  }
  const ws = state.workspace;

  const report = await buildWorkspaceReport(ws);
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];

  // Item-level pricing sample so "who has the cheapest cheese pizza?" works.
  const { data: offers } = await supabase
    .from("offer")
    .select("entity_text,pricing,business:business_id(canonical_name)")
    .in("business_id", scope)
    .order("observed_at", { ascending: false })
    .limit(500);
  const sample: Record<string, { item: string; price: number }[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const o of offers ?? []) {
    const name = (o.business as any)?.canonical_name ?? "Unknown";
    const amount = Number((o.pricing as any)?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = String((o as any).entity_text ?? "").toLowerCase().trim();
    if (!key) continue;
    seen[name] ??= new Set();
    if (seen[name].has(key)) continue;
    seen[name].add(key);
    (sample[name] ??= []).push({ item: (o as any).entity_text, price: amount });
  }
  for (const k of Object.keys(sample)) sample[k] = sample[k].slice(0, 14);

  const context = {
    you: report.pricing.find((p) => p.isTarget)?.name ?? ws.name,
    businesses: report.pricing.map((p) => ({
      name: p.name, you: p.isTarget, pricedItems: p.offers, avgPrice: p.avgPrice, minPrice: p.minPrice, maxPrice: p.maxPrice,
    })),
    reputation: report.reputation.map((r) => ({ name: r.name, you: r.isTarget, rating: r.rating, reviews: r.reviewCount })),
    recentEvents: report.events.slice(0, 18).map((e) => ({ business: e.business, type: e.type, summary: e.summary })),
    recommendations: report.recommendations.slice(0, 8).map((r) => ({ title: r.title, action: r.action })),
    monitoringCost: { projectedPerMonthUsd: report.cost.projectedMonthlyUsd, perBusinessPerMonthUsd: report.cost.perBusinessMonthlyUsd, spentInWindowUsd: report.cost.totalUsd, days: report.cost.days },
    sampleOffersByBusiness: sample,
  };

  try {
    const { data } = await getLlm().callStructured<AskResult>({
      system: SYSTEM,
      text: `Question: ${q}\n\nDATA (JSON):\n${JSON.stringify(context)}`,
      schema: SCHEMA,
      tier: "extract",
      maxTokens: 500,
    });
    return { answerable: !!data.answerable, answer: String(data.answer ?? "").trim() || "I couldn't find that in your data yet.", workspace: ws.name };
  } catch (e) {
    return { answerable: false, answer: `Sorry — I couldn't answer that just now (${(e as Error).message}).` };
  }
}
