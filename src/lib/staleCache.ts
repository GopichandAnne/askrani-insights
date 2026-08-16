import { after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";

/**
 * Serve-stale, revalidate-in-background cache for a per-workspace AI report stored
 * on workspace.goals[key]. This takes the LLM generation OFF the render path so
 * navigating between pages never blocks on it:
 *   • fresh + valid cache → return it.
 *   • stale but valid cache → return it NOW and regenerate in the background
 *     (after the HTTP response) so the NEXT view is fresh. The user never waits.
 *   • no usable cache (first ever view, or the last read failed) → generate inline
 *     once, save, return.
 *
 * Same numbers, same intelligence — only WHEN the refresh happens changes. When
 * called outside a request scope (a worker/cron, where after() isn't available)
 * it regenerates inline, so background callers still get fresh data.
 *
 * `isValid` guards against serving/keeping a failed or empty read. `onRead`
 * optionally transforms the value on the way out (e.g. sanitising). `keep` can
 * veto overwriting a good cache with a worse fresh read (return true to keep old).
 */
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;
interface Dated { at?: string }

export async function staleCached<T extends Dated>(
  ws: WorkspaceRow,
  key: string,
  maxAgeHours: number,
  generate: () => Promise<T>,
  opts: { isValid?: (c: T) => boolean; onRead?: (c: T) => T; keep?: (fresh: T, cached?: T) => boolean } = {},
): Promise<T> {
  const isValid = opts.isValid ?? (() => true);
  const onRead = opts.onRead ?? ((c: T) => c);

  const rls = await createClient();
  const { data } = await rls.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = ((data?.goals as AnyRec | null) ?? {})[key] as T | undefined;
  const freshEnough = !!cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000;

  async function save(val: T) {
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    await svc.from("workspace").update({ goals: { ...((cur?.goals as AnyRec | null) ?? {}), [key]: val } }).eq("id", ws.id);
  }
  async function regen(): Promise<T> {
    const fresh = await generate();
    if (opts.keep?.(fresh, cached)) return cached as T; // veto overwrite (e.g. empty over good)
    await save(fresh);
    return fresh;
  }

  if (cached && isValid(cached)) {
    if (freshEnough) return onRead(cached);
    // Stale but usable → serve NOW, refresh after the response. If we're not in a
    // request scope (worker/cron), after() throws — fall back to inline refresh.
    try {
      after(async () => { try { await regen(); } catch { /* keep stale */ } });
      return onRead(cached);
    } catch {
      return onRead(await regen());
    }
  }

  // No usable cache (first ever view, or last read failed) → generate inline once.
  return onRead(await regen());
}
