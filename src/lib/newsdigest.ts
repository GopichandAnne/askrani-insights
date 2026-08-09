import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Local-news digest — instead of a list of links to open, summarize the collected
 * trends / local news / nearby openings into a few plain-English lines, each
 * attributed to its source (with the link). We already extract article text at
 * collection time, so this reads it and condenses. Cached on workspace.goals.
 */

export interface DigestItem { point: string; source: string; url?: string; kind?: string; }
export interface NewsDigest { summary: string; items: DigestItem[]; at: string; empty?: boolean; failed?: boolean }

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "2–4 plain-English sentences telling a busy owner what's happening in their area & industry from the articles — trends to note, local news, nearby openings. No fluff, no jargon." },
    items: {
      type: "array", description: "3–6 key takeaways, each a single sentence with the source it came from.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          point: { type: "string", description: "One concrete takeaway in plain English." },
          source: { type: "string", description: "The publication/source name for this point." },
          url: { type: "string", description: "The article URL for this point (from the data), or empty." },
          kind: { type: "string", enum: ["trend", "opening", "local"], description: "trend | opening | local" },
        },
        required: ["point", "source", "url", "kind"],
      },
    },
  },
  required: ["summary", "items"],
};

const SYSTEM = "You are Ask Rani, briefing a busy local-business owner on what's happening around them. Summarize ONLY the provided articles — no outside knowledge, no invented facts. Be concrete and useful; always attribute each takeaway to its source. Plain English.";

export async function generateNewsDigest(ws: WorkspaceRow, db?: RlsClient): Promise<NewsDigest> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];
  const { data: news } = await supabase
    .from("content_item")
    .select("text,url,media,published_at")
    .in("business_id", scope)
    .eq("platform", "news")
    .order("published_at", { ascending: false })
    .limit(16);

  const articles = (news ?? []).map((n: any) => ({
    headline: String(n.text ?? "").replace(/\s+/g, " ").trim(),
    source: n.media?.[0]?.source ?? "",
    kind: n.media?.[0]?.kind ?? "local",
    url: n.url ?? "",
    article: String(n.media?.[0]?.excerpt ?? "").replace(/\s+/g, " ").slice(0, 700) || undefined,
  })).filter((a) => a.headline);

  if (!articles.length) return { summary: "", items: [], empty: true, at };
  if (!isLlmConfigured()) {
    // no AI — degrade to a plain list (still better than nothing)
    return { summary: "", items: articles.slice(0, 6).map((a) => ({ point: a.headline, source: a.source, url: a.url, kind: a.kind })), at };
  }

  try {
    const call = () => getLlm().callStructured<{ summary: string; items: DigestItem[] }>({
      system: SYSTEM,
      text: `Summarize what's happening around "${ws.name}" for the owner.\n\nARTICLES (JSON):\n${JSON.stringify(articles)}`,
      schema: SCHEMA,
      tier: "extract",
      maxTokens: 900,
    });
    // one retry on transient failure before we degrade
    const { data } = await call().catch(() => call());
    const strip = (s?: string) => { const v = String(s ?? ""); const j = v.search(/<\/|<(parameter|function|antml|invoke|summary|point)\b/i); return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim(); };
    const items = (data.items ?? []).map((i) => ({ point: strip(i.point), source: strip(i.source), url: i.url || undefined, kind: i.kind }));
    return { summary: strip(data.summary), items, at };
  } catch {
    // AI read failed — still show the raw headlines, but mark it failed so it's
    // never cached as final (getOrMake/warm regenerate the summary next time).
    return { summary: "", items: articles.slice(0, 6).map((a) => ({ point: a.headline, source: a.source, url: a.url, kind: a.kind })), at, failed: true };
  }
}

/** Cached digest (regenerated when older than maxAgeHours). */
export async function getOrMakeNewsDigest(ws: WorkspaceRow, maxAgeHours = 12): Promise<NewsDigest> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as any)?.newsDigest as NewsDigest | undefined;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && !cached.failed) return cached;

  const fresh = await generateNewsDigest(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as any) ?? {}), newsDigest: fresh } }).eq("id", ws.id);
  return fresh;
}
