import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Inspiration watchlist — businesses the owner ADMIRES and wants to emulate, kept
 * deliberately SEPARATE from the competitor rank/price machinery (stored on
 * goals.inspirationWatch, never in competitor_edge), so aspiration never pollutes
 * the "how do I stack up" comparisons. For each watched business we already have
 * data on, one LLM pass distills concrete MOVES to emulate — the formats, cadence
 * and hooks they do well — explicitly NOT their prices or where they rank. Read
 * over already-collected social/content data; no scrape. Hardened + self-healing.
 */

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const SOCIAL = ["instagram", "facebook", "tiktok", "youtube"];

export interface InspirationPick { name: string; moves: string[] }
export interface Inspiration {
  picks: InspirationPick[];
  summary: string;
  watchCount: number;    // how many businesses are on the watchlist
  needsPicks?: boolean;  // true when the watchlist is empty (UI prompts to add)
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    picks: {
      type: "array",
      description: "One entry per watched business that has content to learn from.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string", description: "the watched business name, copied verbatim from the input." },
          moves: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" }, description: "2-3 concrete things they do well that this owner could emulate — about FORMAT, CADENCE, HOOKS, presentation, series, community. Each a single specific sentence. NEVER about their prices or search ranking." },
        }, required: ["name", "moves"],
      },
    },
    summary: { type: "string", description: "1-2 plain sentences: the single most valuable habit to borrow from this watchlist." },
  },
  required: ["picks", "summary"],
};

const SYSTEM =
  "You help a local business owner learn from businesses they admire. Given the recent SOCIAL/CONTENT posts of each watched business, extract concrete moves to EMULATE — how they present, what formats they use, posting cadence, recurring series, hooks, community tactics. Ground everything ONLY in the posts provided. Focus strictly on craft and presentation; do NOT mention prices, discounts, or search ranking (this is inspiration, not competitive price/rank analysis). Plain, practical, specific.";

const empty = (at: string, opts?: { needsPicks?: boolean; failed?: boolean }): Inspiration =>
  ({ picks: [], summary: "", watchCount: 0, ...(opts?.needsPicks ? { needsPicks: true } : {}), at, empty: true, ...(opts?.failed ? { failed: true } : {}) });

/** Business ids the owner has starred to emulate (validated to the workspace's set). */
export function watchlistIds(goals: Record<string, any> | null | undefined): string[] {
  const raw = (goals?.inspirationWatch as unknown);
  return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
}

export async function generateInspiration(ws: WorkspaceRow, db?: RlsClient): Promise<Inspiration> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const watch = watchlistIds(ws.goals as Record<string, any>);
  if (!watch.length) return empty(at, { needsPicks: true });

  const [{ data: bizRows }, { data: posts }] = await Promise.all([
    supabase.from("business").select("id, canonical_name").in("id", watch),
    supabase.from("content_item").select("business_id, text, platform, published_at").in("business_id", watch).in("platform", SOCIAL).order("published_at", { ascending: false, nullsFirst: false }).limit(120),
  ]);
  const nameById = new Map<string, string>(((bizRows ?? []) as any[]).map((b) => [b.id as string, clean(b.canonical_name) || "a business"]));
  const watchCount = watch.length;

  const perBiz = new Map<string, string[]>();
  for (const p of (posts ?? []) as any[]) {
    const t = clean(p.text);
    if (t.length < 10) continue;
    const name = nameById.get(p.business_id as string) ?? "a business";
    const arr = perBiz.get(name) ?? perBiz.set(name, []).get(name)!;
    if (arr.length < 15) arr.push(`[${clean(p.platform)}] ${t.slice(0, 220)}`);
  }
  if (!perBiz.size) return { ...empty(at), watchCount }; // watchlist set but no content collected yet
  if (!isLlmConfigured()) return { ...empty(at), watchCount };

  const block = [...perBiz.entries()].map(([name, ps]) => `--- ${name} ---\n${ps.join("\n")}`).join("\n\n");
  const text = `This business: "${ws.name}" (${ws.vertical}). Below are recent posts from businesses it wants to EMULATE.\n\n${block}\n\nWhat should this owner borrow from them?`;

  try {
    const call = () => getLlm().callStructured<{ picks: any[]; summary: string }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 2200 });
    const { data } = await call().catch(() => call());
    const picks: InspirationPick[] = (Array.isArray(data.picks) ? data.picks : [])
      .map((p) => ({ name: clean(p.name), moves: (Array.isArray(p.moves) ? p.moves : []).map(clean).filter(Boolean).slice(0, 3) }))
      .filter((p) => p.name && p.moves.length).slice(0, 8);
    if (!picks.length) return { ...empty(at), watchCount };
    return { picks, summary: clean(data.summary), watchCount, at };
  } catch {
    return empty(at, { failed: true });
  }
}

export function inspirationIsGood(v: Inspiration): boolean {
  if (v.failed) return false;
  return !!(v.picks.length || v.empty);
}

export function getOrMakeInspiration(ws: WorkspaceRow, maxAgeHours = 24): Promise<Inspiration> {
  return staleCached(ws, "inspiration", maxAgeHours, () => generateInspiration(ws), { isValid: (c) => !c.failed });
}
