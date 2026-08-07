import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Unmet demand" — the demand-side complement to "What's winning". Customers say
 * what they want right in the reviews ("wish they had…", "asked for X", "if only
 * they were open later", "no vegan options"). This mines review text across the
 * whole market for those expressed wants, cross-references what's actually
 * offered (menu), and surfaces the demands FEW or NO nearby businesses meet — the
 * clearest growth openings for the owner. Cached on workspace.goals.demand.
 */

const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;
const NOISE = /\b(small|large|medium|regular|half|full|pcs?|oz|lb|serves?\s*\d+)\b/gi;

export interface DemandItem {
  need: string;
  signal: string;                              // grounded evidence from the reviews
  heat: "high" | "medium" | "low";             // strength of the demand signal
  servedLocally: "no" | "few" | "some";        // how many nearby already meet it
  move: string;                                // what THIS owner should do
}
export interface DemandReport {
  summary: string;
  demands: DemandItem[];
  reviewsSeen: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(NOISE, " ").replace(/\s+/g, " ").trim();

// Same tool-XML-bleed recovery used by the winning layer (models sometimes render
// the array as an <item>… string on big structured calls).
type Raw = { need?: string; signal?: string; heat?: string; servedLocally?: string; move?: string };
function parseTaggedItems(s: string): Raw[] {
  const normalized = s.replace(/<parameter\s+name="([^"]+)">/gi, (_m, t) => `<${t}>`);
  const chunks = normalized.includes("<item>") ? normalized.split(/<item>/i) : normalized.split(/(?=<need>)/i);
  const get = (b: string, tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|<[a-z/]|$)`, "i").exec(b);
    return m ? m[1].trim() : "";
  };
  const out: Raw[] = [];
  for (const b of chunks) {
    const need = get(b, "need");
    const signal = get(b, "signal");
    if (!need || !signal) continue;
    out.push({ need, signal, heat: get(b, "heat"), servedLocally: get(b, "servedLocally"), move: get(b, "move") });
  }
  return out;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", description: "ONE short sentence — the biggest unmet demand opportunity in this market." },
    demands: {
      type: "array", maxItems: 8,
      description: "Things customers WANT but few/none nearby provide — surfaced from the reviews. Most compelling first. Ground each in the review text; never invent.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          need: { type: "string", description: "the specific want (a dish, option, service, hour, format…) e.g. 'Jain/no-onion-garlic options', 'late-night hours', 'catering', 'gluten-free desserts'" },
          signal: { type: "string", description: "≤22 words: how it shows up in the reviews (paraphrase; real, no invented counts)" },
          heat: { type: "string", enum: ["high", "medium", "low"], description: "how strong/repeated the demand is in the reviews" },
          servedLocally: { type: "string", enum: ["no", "few", "some"], description: "how many nearby already meet it, judged from the menu/offer list provided" },
          move: { type: "string", description: "≤16 words: the concrete opening for THIS owner (add it, promote you already do it, extend hours…)" },
        },
        required: ["need", "signal", "heat", "servedLocally", "move"],
      },
    },
  },
  required: ["summary", "demands"],
};

const SYSTEM =
  "You are Ask Rani, finding UNMET DEMAND for a local business. Read the market's customer reviews for things people explicitly WANT but can't get — requests, 'wish they had…', 'asked for…', complaints about something missing (a dish, a dietary option, hours, catering, a service). Cross-reference the list of what's already offered to judge how served each want is. Surface the ones FEW or NO nearby businesses meet — the clearest openings. Your MAIN OUTPUT is the `demands` array (fill it, ~5–8). Ground every item in the reviews; never invent a want or a number. Keep the summary to one sentence.";

const empty = (at: string, failed = false): DemandReport => ({ summary: "", demands: [], reviewsSeen: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateDemand(ws: WorkspaceRow, db?: RlsClient): Promise<DemandReport> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all;
  if (!scope.length) return empty(at);

  const [{ data: reviews }, { data: offers }] = await Promise.all([
    supabase.from("content_item").select("text").in("business_id", scope).in("platform", ["google", "yelp"]).order("observed_at", { ascending: false }).limit(700),
    supabase.from("offer").select("entity_text").in("business_id", scope).limit(6000),
  ]);

  const reviewSnips = (reviews ?? [])
    .map((r) => String((r as any).text ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 25 && !RATING_RE.test(t))
    .slice(0, 45)
    .map((t) => t.slice(0, 240));
  if (reviewSnips.length < 4) return empty(at);

  // compact "what's already offered" list (distinct, most common) to ground "servedLocally"
  const offerCount = new Map<string, number>();
  for (const o of offers ?? []) {
    const k = norm(String((o as any).entity_text ?? ""));
    if (k.length > 2) offerCount.set(k, (offerCount.get(k) ?? 0) + 1);
  }
  const offered = [...offerCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 70).map(([k]) => k).join(", ");

  if (!isLlmConfigured()) return { summary: "", demands: [], reviewsSeen: reviewSnips.length, at, empty: true };

  const prompt =
    `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\n` +
    `CUSTOMER REVIEWS ACROSS THE MARKET:\n${reviewSnips.join("\n")}\n\n` +
    `ALREADY OFFERED NEARBY (to judge how served each want is):\n${offered || "(unknown)"}\n\n` +
    `Surface the unmet demand (fill the demands array).`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ summary: string; demands: Raw[] | string }>({
        system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 2000,
      });
      // Recover from the model's occasional structured-output bleeds: a JSON
      // string of the whole object under `demands`, or an <item>… XML string.
      let rows: Raw[] = [];
      let summaryStr = strip(data.summary);
      if (Array.isArray(data.demands)) {
        rows = data.demands;
      } else if (typeof data.demands === "string") {
        try {
          const p = JSON.parse(data.demands);
          if (Array.isArray(p?.demands)) { rows = p.demands; summaryStr = summaryStr || strip(p.summary); }
          else if (Array.isArray(p)) rows = p;
        } catch { /* not JSON */ }
        if (!rows.length) rows = parseTaggedItems(data.demands);
      }
      const demands: DemandItem[] = rows
        .map((d) => ({
          need: strip(d.need),
          signal: strip(d.signal),
          heat: (["high", "medium", "low"].includes(d.heat ?? "") ? d.heat : "medium") as DemandItem["heat"],
          servedLocally: (["no", "few", "some"].includes(d.servedLocally ?? "") ? d.servedLocally : "few") as DemandItem["servedLocally"],
          move: strip(d.move),
        }))
        .filter((d) => d.need && d.signal)
        .slice(0, 8);
      if (demands.length) return { summary: summaryStr, demands, reviewsSeen: reviewSnips.length, at };
    } catch (e) {
      if (process.env.DEMAND_DEBUG) console.error("generateDemand error:", (e as Error).message);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
  }
  return empty(at, true);
}

export function demandIsGood(d: DemandReport): boolean {
  return !!(d.demands.length || d.empty);
}

/** Cached unmet-demand read (regenerated when older than maxAgeHours). */
export async function getOrMakeDemand(ws: WorkspaceRow, maxAgeHours = 12): Promise<DemandReport> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as { demand?: DemandReport } | null)?.demand;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && !cached.failed) return cached;

  const fresh = await generateDemand(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), demand: fresh } }).eq("id", ws.id);
  return fresh;
}
