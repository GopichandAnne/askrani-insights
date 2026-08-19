import { createServiceClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Intelligent market-intel config for a vertical that has NO hand-tuned entry.
 *
 * The curated verticals (restaurant/grocery/salon/smoke_vape/fitness/dental/
 * real_estate) keep their tuned, cuisine-aware discovery queries + hashtags — free
 * and instant. Anything else (a business the classifier placed as `other`, or a
 * type we haven't hand-tuned) gets its competitor-discovery search phrase and
 * industry hashtags DERIVED by the classifier-tier LLM, and cached in
 * `vertical_profile` — one model call per vertical, ever. So a new business type
 * needs zero code to get sharp discovery + industry content. Fail-soft: any error
 * (LLM off, table not migrated) returns null and callers keep their generic
 * fallback, so nothing breaks pre-migration.
 */

type Svc = ReturnType<typeof createServiceClient>;

export interface VerticalProfile {
  discovery_query: string | null;
  hashtags: string[];
}

const GEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    discovery_query: {
      type: "string",
      description: "A Google Places TEXT-SEARCH phrase that finds this category's direct competitors. Join close synonyms with OR. No location, no punctuation beyond OR. e.g. 'auto repair shop OR mechanic OR tire shop'.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description: "3-4 Instagram hashtags (lowercase, no # and no spaces) whose TOP posts represent the best-performing content in THIS industry nationally. e.g. ['autorepair','mechaniclife','cartok'].",
    },
  },
  required: ["discovery_query", "hashtags"],
};

const GEN_SYSTEM =
  "You configure market intelligence for a local-business category. Given a category label, produce: (1) a Google Places text-search phrase that finds that category's direct competitors, and (2) 3-4 Instagram hashtags whose top posts show the best-performing content in that industry. Be specific to the category. No location in the query; no '#' in the hashtags.";

async function generate(vertical: string): Promise<VerticalProfile | null> {
  if (!isLlmConfigured()) return null;
  try {
    const { data } = await getLlm().callStructured<VerticalProfile>({
      system: GEN_SYSTEM,
      text: `CATEGORY / VERTICAL: ${vertical.replace(/_/g, " ")}`,
      schema: GEN_SCHEMA,
      tier: "classify",
      maxTokens: 160,
    });
    const query = String(data?.discovery_query ?? "").trim().slice(0, 200) || null;
    const hashtags = Array.isArray(data?.hashtags)
      ? data.hashtags.map((t) => String(t).replace(/[^a-z0-9]/gi, "").toLowerCase()).filter(Boolean).slice(0, 4)
      : [];
    if (!query && !hashtags.length) return null;
    return { discovery_query: query, hashtags };
  } catch {
    return null;
  }
}

/** Cached LLM-derived profile for a vertical. Reads the cache, generates + persists
 *  on a miss. Never throws — returns null so callers fall back to generic. */
export async function getVerticalProfile(svc: Svc, vertical: string): Promise<VerticalProfile | null> {
  try {
    const { data } = await svc
      .from("vertical_profile")
      .select("discovery_query, hashtags")
      .eq("vertical", vertical)
      .maybeSingle();
    if (data) return { discovery_query: data.discovery_query ?? null, hashtags: (data.hashtags as string[]) ?? [] };
  } catch {
    // table not migrated yet → generate (won't persist), still returns intel
  }
  const gen = await generate(vertical);
  if (!gen) return null;
  try {
    await svc.from("vertical_profile").upsert(
      { vertical, discovery_query: gen.discovery_query, hashtags: gen.hashtags, updated_at: new Date().toISOString() },
      { onConflict: "vertical" },
    );
  } catch {
    // best-effort cache; a failed write just means we regenerate next time
  }
  return gen;
}
