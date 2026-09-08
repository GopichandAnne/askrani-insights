import { createServiceClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Concept CANONICALIZATION — the cached map that makes the "falling behind"
 * detector STABLE run-to-run. Without it, the LLM re-clusters market_event titles
 * differently each pass (the same workspace gave 2 flags one run and 8 the next),
 * which breaks any velocity/history tracking. This fixes that with two disciplines:
 *
 *   • FROZEN + ADDITIVE — once a surface form (normalized title) is assigned a
 *     concept, that assignment is immutable; the map only grows. A title seen again
 *     always resolves to the same concept, so history stays coherent.
 *   • DETERMINISTIC resolve, LLM only for NEW forms — cached titles resolve by a
 *     free map lookup; only surface forms never seen before hit the LLM, and that
 *     call is ANCHORED to the existing concept vocabulary (reuse an existing concept
 *     when it fits) so new titles cluster onto the established set instead of
 *     spawning near-duplicates. Cost falls as the map matures; once every title is
 *     cached the pass is fully deterministic and free.
 *
 * Per-workspace on goals.conceptCanon (a global per-vertical vocabulary is the
 * eventual upgrade). Bias is toward leaving forms separate (under-merge is quiet;
 * over-merge fabricates convergence), matching the engine guardrails.
 */

export type DemandType = "offering" | "quality" | "other" | "na";
export interface ConceptAssign { concept: string; demand_type: DemandType }
export interface ConceptCanon { assign: Record<string, ConceptAssign>; at: string; size: number }

/** Deterministic surface-form key: lowercase, drop urls/emoji/punctuation/non-latin,
 *  collapse. Exact repeats collapse to one key (a frozen assignment); trivial
 *  variants share a key, real variants get their own (and the LLM anchors them). */
export const conceptKey = (s: string): string =>
  String(s ?? "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    map: {
      type: "array", description: "One entry per numbered input line.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          i: { type: "integer" },
          concept: { type: "string", description: "action-granularity concept, REUSED verbatim from the existing list when it fits" },
          demand_type: { type: "string", enum: ["offering", "quality", "other", "na"] },
        },
        required: ["i", "concept", "demand_type"],
      },
    },
  },
  required: ["map"],
};

function systemPrompt(vocab: string[]): string {
  return (
    "You canonicalize local-business market signals for a competitive detector. For EACH numbered input line return one `concept` and a `demand_type`.\n" +
    "CONCEPT = action granularity: the level where one concept = one distinct move an owner could make. Use the SAME concept whether a phrase came from a customer review (demand) or a competitor promo (supply), so they can be matched. Examples that MUST share a concept: 'Catering for large events' + 'party trays 20% off' + 'large-group combo' => 'catering / large-group orders'; '$0 delivery fee first order' + 'wish delivery were free' => 'free/discounted delivery'; 'new veg thali' + 'wish they had more vegetarian' => 'vegetarian options'. Group festival/occasion specials as 'festival / occasion special'; individual grocery produce items as 'grocery produce assortment'.\n" +
    "demand_type (ONLY for [demand] lines; use 'na' otherwise): 'offering' = a wish for a PRODUCT/SERVICE/FORMAT/CUISINE/OCCASION the business could ADD or promote (an opportunity); 'quality' = a complaint about EXECUTION of existing operations (cleanliness, speed, consistency, spice accuracy, freshness, service — NOT an opportunity); 'other' = neither." +
    (vocab.length
      ? "\n\nEXISTING CONCEPTS — prefer REUSING one of these verbatim when a line fits it; only invent a new concept when none fits:\n" + vocab.map((v) => `- ${v}`).join("\n")
      : "")
  );
}

export interface ResolveResult { tags: (ConceptAssign | null)[]; llmFailed: boolean; added: number }

/**
 * Resolve each item to {concept, demand_type}: cached forms via lookup (frozen),
 * new forms via one anchored LLM call, then persist the grown map. Returns tags
 * aligned to `items`; a null tag means unresolved (skip it). Robust to a down LLM:
 * cached items still resolve, so a mature map keeps working with no model calls.
 */
export async function resolveConcepts(ws: WorkspaceRow, items: { kind: string; text: string }[]): Promise<ResolveResult> {
  const cached = ((ws.goals as { conceptCanon?: ConceptCanon } | null)?.conceptCanon?.assign ?? {}) as Record<string, ConceptAssign>;
  const tags: (ConceptAssign | null)[] = new Array(items.length).fill(null);

  // group the unmapped by their normalized key so identical forms cost one LLM line
  const uniq = new Map<string, { kind: string; text: string; idxs: number[] }>();
  items.forEach((it, i) => {
    const key = conceptKey(it.text);
    if (!key) return;
    const hit = cached[key];
    if (hit) { tags[i] = hit; return; }
    const e = uniq.get(key) ?? { kind: it.kind, text: it.text, idxs: [] };
    e.idxs.push(i); uniq.set(key, e);
  });

  if (!uniq.size) return { tags, llmFailed: false, added: 0 };       // fully cached → deterministic, free
  if (!isLlmConfigured()) return { tags, llmFailed: true, added: 0 };

  const list = [...uniq.entries()];
  // BATCH the LLM calls: a workspace with hundreds of unseen concepts (e.g. a
  // 400-event grocery store) overflows a single call → it fails, nothing caches,
  // and it fails identically forever (a doom loop). Batching lets the map build
  // incrementally: a failed batch loses only itself, and each run advances the
  // cache so the next run resolves more. The running vocab carries new concepts
  // forward so later batches reuse earlier ones (clustering stays consistent).
  const BATCH = 100;
  const runningVocab = new Set(Object.values(cached).map((c) => c.concept));
  const newAssign: Record<string, ConceptAssign> = {};
  let anyBatchOk = false;

  for (let start = 0; start < list.length; start += BATCH) {
    const chunk = list.slice(start, start + BATCH);
    const vocab = [...runningVocab].slice(0, 100);
    const lines = chunk.map(([, v], j) => `${j}\t[${v.kind}] ${v.text.replace(/\s+/g, " ").trim().slice(0, 120)}`).join("\n");
    try {
      const call = () => getLlm().callStructured<{ map: { i: number; concept: string; demand_type: DemandType }[] }>({
        system: systemPrompt(vocab), text: lines, schema: SCHEMA, tier: "classify", maxTokens: 9000,
      });
      const { data } = await call().catch(() => call());
      const out = new Map((Array.isArray(data.map) ? data.map : []).map((x) => [x.i, x]));
      chunk.forEach(([key, v], j) => {
        const r = out.get(j);
        const concept = String(r?.concept ?? "").replace(/\s+/g, " ").trim();
        if (!concept) return;
        const dt: DemandType = (["offering", "quality", "other", "na"] as const).includes(r!.demand_type) ? r!.demand_type : "na";
        const tag: ConceptAssign = { concept, demand_type: dt };
        newAssign[key] = tag;
        runningVocab.add(concept);
        for (const idx of v.idxs) tags[idx] = tag;
      });
      anyBatchOk = true;
    } catch { /* skip this batch; other batches still advance the cache */ }
  }
  if (!Object.keys(newAssign).length) return { tags, llmFailed: true, added: 0 };

  // persist: fresh read-merge-write; EXISTING assignments win (frozen), new ones added
  try {
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    const prev = ((cur?.goals as { conceptCanon?: ConceptCanon } | null)?.conceptCanon?.assign ?? {}) as Record<string, ConceptAssign>;
    const merged = { ...newAssign, ...prev };
    const report: ConceptCanon = { assign: merged, at: new Date().toISOString(), size: Object.keys(merged).length };
    await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), conceptCanon: report } }).eq("id", ws.id);
  } catch { /* tags already resolved this run; persistence retries next run */ }
  return { tags, llmFailed: !anyBatchOk, added: Object.keys(newAssign).length };
}
