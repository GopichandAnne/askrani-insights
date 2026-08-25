import { createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Price CANONICALIZATION — the intelligent half of the like-for-like Price score.
 * Deterministic name-matching can't tell that "Idly" = "Idli", "Beetroot" =
 * "Chukandar" = "Beets", or "Gel manicure" ≈ "Gel nails". This does one cached LLM
 * pass over the market's priced items and groups genuinely-equivalent offerings —
 * synonyms, other languages, spelling/portion variants — into a canonical label,
 * vertical-aware and with NO hardcoded vocab. The scorecard then builds its shared
 * basket on these canonical labels, so the comparison is truly apples-to-apples.
 * Cached on workspace.goals.priceCanon; refreshed weekly from the warm hook.
 */

export interface PriceCanon { canon: Record<string, string>; at: string; groups: number }

const norm = (s: string): string => s.toLowerCase()
  .replace(/\([^)]*\)/g, " ")
  .replace(/\b\d+(?:\.\d+)?\s*(?:pcs?|pieces?|oz|ml|lbs?|kg|ct|pack)\b/g, " ")
  .replace(/\b\d+(?:\.\d+)?\b/g, " ")
  .replace(/[^a-z ]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    groups: {
      type: "array", maxItems: 90,
      description: "Groups of 2+ item names from the list that are the SAME real offering (synonyms/other languages/spelling or portion variants). Omit items with no equivalent.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          canonical: { type: "string", description: "short plain-English label for the shared offering" },
          members: { type: "array", items: { type: "string" }, description: "the exact item names from the list that mean this offering (2+)" },
        },
        required: ["canonical", "members"],
      },
    },
  },
  required: ["groups"],
};

const SYSTEM =
  "You canonicalize a local business market's priced items so the SAME real offering is recognized even when named differently. Group names ONLY when they're genuinely the same offering — account for synonyms, other languages, transliteration/spelling, and portion wording — using the business VERTICAL for context (grocery: Beetroot = Chukandar = Beets; restaurant: Idly = Idli, 'Chicken Biryani' variants; salon: 'Gel manicure' ≈ 'Gel nails'; barber: \"Men's haircut\" ≈ \"Men's cut\"; med-spa: 'Botox per unit', 'HydraFacial'). Do NOT merge genuinely different offerings (Chicken Biryani ≠ Goat Biryani; a distinctly-priced small ≠ family pack). Return ONLY groups with 2+ members; skip anything with no equivalent. No hardcoded assumptions — reason from the vertical.";

/** Build + cache the canonical map for a workspace's market. Fail-soft → empty map. */
export async function buildPriceCanon(ws: WorkspaceRow, db?: any): Promise<PriceCanon> {
  const at = new Date().toISOString();
  const svc = db ?? createServiceClient();
  const empty: PriceCanon = { canon: {}, at, groups: 0 };
  if (!isLlmConfigured()) return empty;

  const ids = await workspaceBusinessIds(ws, svc);
  const scope = ids.all.length ? ids.all : [];
  if (!scope.length) return empty;

  // distinct priced item names across the market, prioritized by how many
  // businesses offer them (the shared ones are what the basket needs), capped.
  const { data: offs } = await svc.from("offer").select("entity_text, pricing, business_id").in("business_id", scope).limit(6000);
  const byName = new Map<string, Set<string>>();
  for (const o of offs ?? []) {
    const raw = String((o as any).entity_text ?? "").replace(/\s+/g, " ").trim();
    const amt = Number((o as any).pricing?.amount);
    if (!raw || !(Number.isFinite(amt) && amt > 0)) continue;
    const key = raw.toLowerCase();
    (byName.get(key) ?? byName.set(key, new Set()).get(key)!).add((o as any).business_id);
  }
  const names = [...byName.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 150).map(([n]) => n);
  if (names.length < 4) return empty;

  const nameSet = new Set(names);
  try {
    const { data } = await getLlm().callStructured<{ groups: { canonical: string; members: string[] }[] }>({
      system: SYSTEM,
      text: `Vertical: ${ws.vertical}.\nItem names (one per line):\n${names.join("\n")}\n\nGroup the equivalent ones.`,
      schema: SCHEMA, tier: "extract", maxTokens: 3000,
    });
    // Guard against the LLM over-merging SIZE/PORTION variants (e.g. "biryani" +
    // "biryani family pack") — those are distinct, distinctly-priced offerings, not
    // the same basket item. A valid merge must span 2+ genuinely different BASE
    // names (a real synonym/language/spelling equivalence), not one base at
    // different sizes. This keeps only the intelligence deterministic matching lacks.
    const SIZE_WORDS = "family|party|catering|large|small|half|full|jumbo|mini|regular|combo|meal|platter|bulk|dozen|packs?|trays?|serves?|servings?|people|persons?|value|deluxe|premium";
    const base = (s: string) => norm(s).replace(new RegExp(`\\b(${SIZE_WORDS})\\b`, "g"), " ").replace(/\s+/g, " ").trim();
    const hasSize = (s: string) => new RegExp(`\\b(${SIZE_WORDS})\\b`).test(s);
    const canon: Record<string, string> = {};
    let groups = 0;
    for (const g of data?.groups ?? []) {
      const members = (g.members ?? []).map((m) => String(m ?? "").toLowerCase().trim()).filter((m) => nameSet.has(m));
      if (members.length < 2) continue;
      if (new Set(members.map(base)).size < 2) continue; // pure size-variant group → skip
      const clean = members.filter((m) => !hasSize(m)); // never fold a size/portion variant into the shared item
      if (clean.length < 2) continue;
      const label = norm(String(g.canonical ?? "")) || norm(clean[0]);
      if (!label) continue;
      groups++;
      for (const m of clean) canon[norm(m)] = label; // map each clean variant's normed name → shared canonical
    }
    const report: PriceCanon = { canon, at, groups };
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), priceCanon: report } }).eq("id", ws.id);
    return report;
  } catch {
    return empty;
  }
}
