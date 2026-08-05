import { createClient, createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Trending near you" — category-level trends grounded in REAL local engagement,
 * not national news. We take the highest-engagement recent posts across the
 * workspace's competitors (+ their recent new items/promos) and let the model
 * spot what's actually catching on locally right now — specific dishes, services,
 * formats or themes — each with the evidence and a concrete move for the owner.
 * Cached on workspace.goals.localTrends.
 */

export interface TrendItem {
  topic: string;
  momentum: "hot" | "rising" | "steady";
  evidence: string;
  competitors: string[];
  yourMove: string;
}
export interface LocalTrends {
  summary: string;
  trends: TrendItem[];
  at: string;
  empty?: boolean;
}

const SOCIAL = ["instagram", "facebook", "tiktok", "youtube"];
const NEW_TYPES = /new_dish|new_item|new_product|new_treatment|promo|sale|combo|special/i;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "1–2 plain sentences: what's catching on in this local category right now." },
    trends: {
      type: "array",
      description: "3–6 concrete, category-level trends gaining traction LOCALLY — specific dishes/services/products/formats/themes, not generic advice. Fewer is better than inventing.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string", description: "The trend, concrete + plain (e.g. 'Birria tacos', 'Weekend brunch reels', 'Lip filler day promos')." },
          momentum: { type: "string", enum: ["hot", "rising", "steady"], description: "hot = big engagement now; rising = building; steady = consistently popular." },
          evidence: { type: "string", description: "Why it's trending, grounded in the data — which rivals, engagement numbers, recency. No invented figures." },
          competitors: { type: "array", items: { type: "string" }, description: "Rival names driving it (from the data)." },
          yourMove: { type: "string", description: "One concrete thing THIS owner could do about it this week." },
        },
        required: ["topic", "momentum", "evidence", "competitors", "yourMove"],
      },
    },
  },
  required: ["summary", "trends"],
};

const SYSTEM =
  "You are Ask Rani, spotting what's trending in a local business category RIGHT NOW — strictly from the provided local competitor social posts (with engagement numbers) and their recent new items/promos. Identify concrete, category-level trends gaining traction locally: specific dishes, services, products, formats or themes. NOT generic marketing advice. Ground every trend in the evidence (which rivals, engagement, recency) and never invent numbers. Plain English. If the evidence is thin, return fewer trends.";

const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke|summary|topic)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;

export async function generateLocalTrends(ws: WorkspaceRow, days = 60): Promise<LocalTrends> {
  const at = new Date().toISOString();
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws);
  const compScope = ids.competitorIds;
  if (!compScope.length) return { summary: "", trends: [], empty: true, at };

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const [{ data: posts }, { data: events }] = await Promise.all([
    supabase
      .from("content_item")
      .select("text, platform, media, published_at, observed_at, business:business_id(canonical_name)")
      .in("business_id", compScope)
      .in("platform", SOCIAL)
      .order("observed_at", { ascending: false })
      .limit(400),
    supabase
      .from("market_event")
      .select("event_type, summary, time_start, business:business_id(canonical_name)")
      .eq("workspace_id", ws.id)
      .in("business_id", compScope)
      .gte("created_at", cutoff)
      .order("time_start", { ascending: false })
      .limit(60),
  ]);

  // top posts by engagement — the momentum signal
  const rankedPosts = (posts ?? [])
    .map((p) => {
      const mm = metricsOf((p as { media: unknown }).media);
      return {
        business: (p as { business?: { canonical_name?: string } }).business?.canonical_name ?? "A competitor",
        platform: (p as { platform: string }).platform,
        caption: String((p as { text?: string }).text ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
        views: mm?.views,
        likes: mm?.likes,
        comments: mm?.comments,
        eng: engOf(mm),
      };
    })
    .filter((x) => x.caption.length > 4)
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 30);

  const recentMoves = (events ?? [])
    .filter((e) => NEW_TYPES.test(String((e as { event_type: string }).event_type)))
    .slice(0, 20)
    .map((e) => ({
      business: (e as { business?: { canonical_name?: string } }).business?.canonical_name ?? "A competitor",
      change: (e as { summary?: string }).summary ?? String((e as { event_type: string }).event_type),
    }));

  if (rankedPosts.length < 3 && recentMoves.length < 3) return { summary: "", trends: [], empty: true, at };
  if (!isLlmConfigured()) return { summary: "", trends: [], empty: true, at };

  try {
    const { data } = await getLlm().callStructured<{ summary: string; trends: TrendItem[] }>({
      system: SYSTEM,
      text: `Business: "${ws.name}" (vertical: ${ws.vertical}). Spot what's trending locally.\n\nTOP LOCAL COMPETITOR POSTS BY ENGAGEMENT (JSON):\n${JSON.stringify(rankedPosts)}\n\nRECENT COMPETITOR NEW ITEMS / PROMOS (JSON):\n${JSON.stringify(recentMoves)}`,
      schema: SCHEMA,
      tier: "extract",
      maxTokens: 1300,
    });
    const trends = (data.trends ?? []).slice(0, 6).map((t) => ({
      topic: strip(t.topic),
      momentum: (["hot", "rising", "steady"].includes(t.momentum) ? t.momentum : "rising") as TrendItem["momentum"],
      evidence: strip(t.evidence),
      competitors: Array.isArray(t.competitors) ? t.competitors.map(strip).filter(Boolean).slice(0, 5) : [],
      yourMove: strip(t.yourMove),
    })).filter((t) => t.topic);
    return { summary: strip(data.summary), trends, at };
  } catch {
    return { summary: "", trends: [], empty: true, at };
  }
}

/** Cached local trends (regenerated when older than maxAgeHours). */
export async function getOrMakeLocalTrends(ws: WorkspaceRow, maxAgeHours = 12): Promise<LocalTrends> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as { localTrends?: LocalTrends } | null)?.localTrends;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000) return cached;

  const fresh = await generateLocalTrends(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), localTrends: fresh } }).eq("id", ws.id);
  return fresh;
}
