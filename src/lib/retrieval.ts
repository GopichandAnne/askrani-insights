import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Live-DB retrieval (RAG-lite) for the assistant. The cached pillars are great
 * SUMMARIES, but exact prices / specific posts / recent changes live in the raw
 * tables. Given a question we pull the most relevant rows from offer (menu/prices),
 * content_item (competitor posts) and market_event (what changed), ranked by
 * keyword match + recency and capped, then hand them back as a grounded block.
 * No embeddings/vector store — lexical + recency, which is precise and cheap here.
 */

const STOP = new Set(["the", "a", "an", "and", "or", "but", "my", "our", "their", "your", "how", "what", "whats", "why", "who", "when", "where", "which", "is", "are", "was", "were", "do", "does", "did", "can", "could", "should", "would", "i", "we", "they", "you", "of", "for", "to", "in", "on", "at", "by", "vs", "me", "about", "this", "that", "with", "from", "any", "some", "tell", "show", "give", "get", "have", "has", "much", "many", "more", "most", "than", "then", "them", "there", "here", "now", "just", "like", "into", "out", "up", "down", "over", "vs.", "am", "pm"]);

const keywords = (q: string): string[] =>
  Array.from(new Set(q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t)))).slice(0, 6);

interface WsRef { id: string; target_business_id?: string | null }

/** Retrieve a compact, ranked block of raw records relevant to the question. */
export async function retrieveLiveContext(svc: SupabaseClient, ws: WsRef, question: string): Promise<string> {
  const kw = keywords(question);

  const { data: edges } = await svc.from("competitor_edge").select("competitor_id").eq("workspace_id", ws.id);
  const compIds = (edges ?? []).map((e: any) => e.competitor_id).filter(Boolean) as string[];
  const allIds = [ws.target_business_id, ...compIds].filter(Boolean) as string[];
  if (!allIds.length) return "";

  const { data: bizRows } = await svc.from("business").select("id, canonical_name").in("id", allIds);
  const nameById = new Map((bizRows ?? []).map((b: any) => [b.id, b.canonical_name as string]));
  const nameOf = (id: string) => (id === ws.target_business_id ? "You" : nameById.get(id) ?? "A rival");

  const blocks: string[] = [];

  // 1) OFFERS — precise menu/price rows matching the question keywords
  if (kw.length) {
    const orExpr = kw.map((k) => `entity_text.ilike.%${k}%`).join(",");
    const { data: offers } = await svc
      .from("offer").select("entity_text, pricing, business_id, observed_at")
      .in("business_id", allIds).or(orExpr).order("observed_at", { ascending: false }).limit(40);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const o of (offers ?? []) as any[]) {
      const label = String(o.entity_text ?? "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      const key = `${o.business_id}|${label.toLowerCase()}`;
      if (seen.has(key)) continue; seen.add(key);
      const amt = Number(o.pricing?.amount);
      lines.push(`- ${nameOf(o.business_id)}: ${label}${amt > 0 ? ` — $${amt}` : ""}`);
      if (lines.length >= 16) break;
    }
    if (lines.length) blocks.push(`### Matching menu/price records\n${lines.join("\n")}`);
  }

  // 2) COMPETITOR POSTS — keyword-matched if we have terms, else most recent
  const postCols = "text, platform, observed_at, business_id";
  const postBase = svc.from("content_item").select(postCols).in("business_id", compIds.length ? compIds : allIds);
  const postsRes = kw.length
    ? await postBase.or(kw.map((k) => `text.ilike.%${k}%`).join(",")).order("observed_at", { ascending: false }).limit(12)
    : await postBase.in("platform", ["instagram", "facebook", "tiktok", "google"]).order("observed_at", { ascending: false }).limit(10);
  const plines: string[] = [];
  for (const p of (postsRes.data ?? []) as any[]) {
    const t = String(p.text ?? "").replace(/\s+/g, " ").trim();
    if (t.length < 8) continue;
    plines.push(`- ${nameOf(p.business_id)} (${p.platform}): "${t.slice(0, 150)}"`);
    if (plines.length >= 8) break;
  }
  if (plines.length) blocks.push(`### Recent competitor posts\n${plines.join("\n")}`);

  // 3) MARKET EVENTS — what actually changed lately, most significant first
  const { data: events } = await svc
    .from("market_event").select("event_type, summary, significance, created_at, business_id")
    .eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(10);
  const elines: string[] = [];
  for (const e of (events ?? []) as any[]) {
    const sum = String(e.summary ?? "").replace(/\s+/g, " ").trim();
    if (!sum) continue;
    elines.push(`- ${e.business_id ? nameOf(e.business_id) + ": " : ""}${sum}`);
    if (elines.length >= 6) break;
  }
  if (elines.length) blocks.push(`### Recent market changes\n${elines.join("\n")}`);

  return blocks.join("\n\n");
}
