import { createServiceClient } from "@/lib/supabase/server";

/**
 * Global per-vertical vocabulary accessor (concept_vocab table). Shared across every
 * workspace of a vertical, so a new business inherits the established vocabulary
 * instead of bootstrapping from zero. FROZEN + additive (first writer wins).
 *
 * NON-BREAKING: if the table doesn't exist yet (migration 0076 not applied), every
 * call degrades to a no-op / empty, and callers fall back to their per-workspace
 * goals maps — so the detector behaves exactly as before until the migration lands,
 * then upgrades to global automatically.
 */

export type VocabKind = "concept" | "grocery_kind" | "unit_basis";

let _available: boolean | null = null; // cached per process; a one-time existence probe

async function available(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const svc = createServiceClient();
    const { error } = await svc.from("concept_vocab").select("vertical").limit(1);
    _available = !error;
  } catch { _available = false; }
  return _available;
}

/** Fetch cached assignments for the given surface keys (chunked). {} if unavailable. */
export async function vocabGet<T>(vertical: string, kind: VocabKind, keys: string[]): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  if (!keys.length || !(await available())) return out;
  const svc = createServiceClient();
  const uniq = [...new Set(keys)];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const { data } = await svc.from("concept_vocab").select("surface_key,value").eq("vertical", vertical).eq("kind", kind).in("surface_key", chunk);
    for (const r of data ?? []) out[(r as { surface_key: string }).surface_key] = (r as { value: T }).value;
  }
  return out;
}

/** Insert new assignments, FROZEN (on conflict do nothing). No-op if unavailable. */
export async function vocabPut(vertical: string, kind: VocabKind, entries: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(entries);
  if (!keys.length || !(await available())) return false;
  const svc = createServiceClient();
  const rows = keys.map((surface_key) => ({ vertical, kind, surface_key, value: entries[surface_key] }));
  try {
    for (let i = 0; i < rows.length; i += 500) {
      await svc.from("concept_vocab").upsert(rows.slice(i, i + 500), { onConflict: "vertical,kind,surface_key", ignoreDuplicates: true });
    }
    return true;
  } catch { return false; }
}

/** A sample of distinct concept labels for a vertical, to anchor the LLM (reuse
 *  existing concepts). Concept kind only; [] if unavailable. */
export async function vocabConceptSample(vertical: string, n = 100): Promise<string[]> {
  if (!(await available())) return [];
  const svc = createServiceClient();
  const { data } = await svc.from("concept_vocab").select("value").eq("vertical", vertical).eq("kind", "concept").limit(600);
  const s = new Set<string>();
  for (const r of data ?? []) { const c = (r as { value?: { concept?: string } }).value?.concept; if (c) s.add(c); if (s.size >= n) break; }
  return [...s];
}

/** Whether the global vocabulary store is usable (migration applied). */
export async function vocabAvailable(): Promise<boolean> { return available(); }
