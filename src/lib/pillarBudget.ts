import { after } from "next/server";

const TIMEOUT = Symbol("timeout");

/**
 * Render budget for a pillar page's data build. Heavy pillars synthesize several
 * LLM reports on a cold cache; without a bound the page blocks behind the loading
 * spinner until it (eventually) finishes — the "infinite spinner". This races the
 * build against `ms`: if it wins, you get the data; if it times out, we let the
 * build keep running post-response via after() (so it caches and the NEXT load is
 * instant) and return null so the caller can render a friendly "still analyzing"
 * state instead of spinning forever.
 */
export async function withinBudget<T>(work: Promise<T>, ms = 35_000): Promise<T | null> {
  const timer = new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
  const res = await Promise.race([work, timer]);
  if (res === TIMEOUT) {
    try { after(async () => { try { await work; } catch { /* build failed; nothing to cache */ } }); } catch { /* outside request scope */ }
    return null;
  }
  return res as T;
}
