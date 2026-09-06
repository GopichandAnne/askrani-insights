import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { upcomingOccasionsAll, type Occasion } from "@/lib/occasions";
import type { ActSpec } from "@/lib/digest";

/**
 * Festival planner — context-aware occasion campaigns. It takes the upcoming
 * occasions (the US calendar PLUS cultural/religious festivals, each audience-
 * tagged) and this business's OWN offerings (offer table), and one LLM pass picks
 * the occasions that ACTUALLY fit this business (Diwali for a desi grocery, Lunar
 * New Year for an Asian market, game-day for a pizzeria) and drafts a grounded
 * campaign for each — with a one-tap act. Deterministic occasion source + a single
 * grounded LLM call; hardened + self-healing like the other pillars.
 */

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface FestivalPlan { occasion: string; whenISO: string; inDays: number; audience?: string; why: string; moves: string[]; act: ActSpec }
export interface FestivalPlanner {
  plans: FestivalPlan[];
  summary: string;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    plans: {
      type: "array", maxItems: 3,
      description: "The upcoming occasions that GENUINELY fit this business, most relevant first. Only pick from the provided list; skip ones that don't fit.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          occasion: { type: "string", description: "the occasion name, copied verbatim from the provided list." },
          why: { type: "string", description: "one sentence: why this occasion fits THIS business (audience + what they sell)." },
          moves: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" }, description: "2-3 concrete campaign moves grounded in the business's actual offerings listed below — a bundle, a themed special, a pre-order, a post. Name real items where possible." },
          act: {
            type: "object", additionalProperties: false,
            properties: {
              label: { type: "string", description: "short button label, e.g. 'Draft the Diwali promo'." },
              move: { type: "string", description: "one first-person instruction to a copywriter for the single best artifact for this occasion, grounded in the offerings." },
            }, required: ["label", "move"],
          },
        }, required: ["occasion", "why", "moves", "act"],
      },
    },
    summary: { type: "string", description: "1 sentence: the single most important occasion to prepare for now, and by when." },
  },
  required: ["plans", "summary"],
};

const SYSTEM =
  "You are a local marketing planner. Given a list of UPCOMING OCCASIONS (each with an audience cue and days away) and the business's ACTUAL offerings, pick ONLY the occasions that genuinely fit this business — match the audience to the business (e.g. cultural festivals for a business that clearly serves that community) and the occasion to what they sell. For each, write why it fits and 2-3 concrete campaign moves grounded in their real offerings (name real items), plus the single best artifact to generate now. Never invent offerings; never pick an occasion that doesn't fit. Prefer the soonest high-fit occasions. Plain, practical.";

const empty = (at: string, failed = false): FestivalPlanner => ({ plans: [], summary: "", at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateFestivalPlanner(ws: WorkspaceRow, db?: RlsClient): Promise<FestivalPlanner> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const occasions = upcomingOccasionsAll(new Date(), 75, 12);
  if (!occasions.length) return empty(at);

  const ids = await workspaceBusinessIds(ws, supabase);
  const offeringLines: string[] = [];
  if (ids.targetId) {
    const { data: offers } = await supabase.from("offer").select("entity_text, pricing").eq("business_id", ids.targetId).order("observed_at", { ascending: false }).limit(400);
    const seen = new Set<string>();
    for (const o of (offers ?? []) as any[]) {
      const name = clean(o.entity_text); if (!name) continue;
      const key = norm(name); if (seen.has(key)) continue; seen.add(key);
      const amt = Number(o.pricing?.amount);
      offeringLines.push(Number.isFinite(amt) && amt > 0 ? `${name} — $${amt.toFixed(2)}` : name);
      if (offeringLines.length >= 40) break;
    }
  }

  if (!isLlmConfigured()) return empty(at);

  const byName = new Map<string, Occasion>(occasions.map((o) => [norm(o.name), o]));
  const text =
    `Business: "${ws.name}" (${ws.vertical}).\n\n` +
    `UPCOMING OCCASIONS (name — in N days — audience — note):\n` +
    occasions.map((o) => `- ${o.name} — in ${o.inDays} days — ${o.audience ?? "general"} — ${o.note}`).join("\n") +
    `\n\nTHIS BUSINESS'S OFFERINGS:\n` +
    (offeringLines.length ? offeringLines.join("\n") : "(none captured yet — keep moves general but on-brand)") +
    `\n\nPick the occasions that fit this business and plan each.`;

  try {
    const call = () => getLlm().callStructured<{ plans: any[]; summary: string }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 2800 });
    const { data } = await call().catch(() => call());
    const plans: FestivalPlan[] = (Array.isArray(data.plans) ? data.plans : [])
      .map((p) => {
        const occ = byName.get(norm(clean(p.occasion)));
        if (!occ) return null; // must be a real upcoming occasion we provided
        const moves = (Array.isArray(p.moves) ? p.moves : []).map(clean).filter(Boolean).slice(0, 3);
        if (!moves.length) return null;
        return {
          occasion: occ.name, whenISO: occ.whenISO, inDays: occ.inDays, audience: occ.audience,
          why: clean(p.why),
          moves,
          act: { kind: "promo" as const, move: clean(p.act?.move) || `Plan a ${occ.name} campaign`, context: `${occ.name} (in ${occ.inDays} days). Moves: ${moves.join("; ")}.` },
        } as FestivalPlan;
      })
      .filter(Boolean) as FestivalPlan[];
    if (!plans.length) return empty(at);
    return { plans: plans.sort((a, b) => a.inDays - b.inDays), summary: clean(data.summary), at };
  } catch {
    return empty(at, true);
  }
}

export function festivalIsGood(v: FestivalPlanner): boolean {
  if (v.failed) return false;
  return !!(v.plans.length || v.empty);
}

export function getOrMakeFestivalPlanner(ws: WorkspaceRow, maxAgeHours = 24): Promise<FestivalPlanner> {
  return staleCached(ws, "festival", maxAgeHours, () => generateFestivalPlanner(ws), { isValid: (c) => !c.failed });
}
