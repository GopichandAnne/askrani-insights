import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
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
  /** time-horizon: "coming" = emerging/building (get ahead), "now" = peaking (act). */
  tense: "coming" | "now";
  /** the owner's window to act — timing + urgency in plain words. */
  window: string;
  evidence: string;
  competitors: string[];
  yourMove: string;
}
export interface LocalTrends {
  summary: string;
  trends: TrendItem[];
  at: string;
  empty?: boolean;   // genuinely little data (few posts) — a valid terminal state
  failed?: boolean;  // the LLM call errored — distinguishable so callers can retry
}

const SOCIAL = ["instagram", "facebook", "tiktok", "youtube"];
const NEW_TYPES = /new_dish|new_item|new_product|new_treatment|promo|sale|combo|special/i;

// The owner's "window to act", derived from the trend's momentum (kept out of the
// LLM schema — asking the model for it made it drop the trends array entirely).
const WINDOW_BY_MOMENTUM: Record<TrendItem["momentum"], string> = {
  hot: "Act this week — it's peaking now",
  rising: "Next few weeks — get in before rivals pile on",
  steady: "Ongoing — a staple worth leaning on",
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    trends: {
      type: "array",
      description: "3–6 concrete, category-level trends gaining traction LOCALLY — specific dishes/services/products/formats/themes, not generic advice. Fewer is better than inventing.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string", description: "The trend, concrete + plain (e.g. 'Birria tacos', 'Weekend brunch reels', 'Lip filler day promos')." },
          momentum: { type: "string", enum: ["hot", "rising", "steady"], description: "hot = big engagement now (peaking); rising = building/emerging; steady = consistently popular." },
          evidence: { type: "string", description: "Why it's trending, grounded in the data — which rivals, engagement numbers, recency. No invented figures." },
          competitors: { type: "array", items: { type: "string" }, description: "Rival names driving it (from the data)." },
          yourMove: { type: "string", description: "One concrete thing THIS owner could do about it this week." },
        },
        required: ["topic", "momentum", "evidence", "competitors", "yourMove"],
      },
    },
    summary: { type: "string", description: "OPTIONAL — one short sentence; only after the trends array." },
  },
  required: ["trends"],
};

const SYSTEM =
  "You are Ask Rani, spotting what's trending in a local business category RIGHT NOW — strictly from the provided local competitor social posts (with engagement numbers) and their recent new items/promos. Identify concrete, category-level trends gaining traction locally: specific dishes, services, products, formats or themes. NOT generic marketing advice. Set `momentum` honestly: 'rising' for something emerging/early (a rival or two, building), 'hot' for something already peaking (several rivals, high engagement), 'steady' for an established staple. Ground every trend in the evidence (which rivals, engagement, recency) and never invent numbers. Plain English. If the evidence is thin, return fewer trends.";

const strip = (s?: string) => {
  const v = String(s ?? "");
  const j = v.search(/<\/|<(parameter|function|antml|invoke|summary|topic)\b/i);
  return (j >= 0 ? v.slice(0, j) : v).replace(/\s+/g, " ").trim();
};
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;

export async function generateLocalTrends(ws: WorkspaceRow, days = 60, db?: RlsClient): Promise<LocalTrends> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
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

  const prompt = `Business: "${ws.name}" (vertical: ${ws.vertical}). Spot what's trending locally.\n\nTOP LOCAL COMPETITOR POSTS BY ENGAGEMENT (JSON):\n${JSON.stringify(rankedPosts)}\n\nRECENT COMPETITOR NEW ITEMS / PROMOS (JSON):\n${JSON.stringify(recentMoves)}`;
  // Big structured calls occasionally bleed the array as a JSON string under the
  // field (or the whole object) — recover, then retry a couple times.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ summary: string; trends: TrendItem[] | string }>({
        system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 1300,
      });
      let rows: any[] = Array.isArray(data.trends) ? data.trends : [];
      let summaryStr = strip(data.summary);
      if (!rows.length && typeof data.trends === "string") {
        try { const p = JSON.parse(data.trends); if (Array.isArray(p?.trends)) { rows = p.trends; summaryStr = summaryStr || strip(p.summary); } else if (Array.isArray(p)) rows = p; } catch { /* not JSON */ }
      }
      const trends = rows.slice(0, 6).map((t) => {
        const momentum = (["hot", "rising", "steady"].includes(t.momentum) ? t.momentum : "rising") as TrendItem["momentum"];
        return {
          topic: strip(t.topic),
          momentum,
          // three-tense framing derived from the (reliable) momentum signal:
          // rising = emerging → "coming" (get ahead); hot/steady = "now" (act).
          tense: (momentum === "rising" ? "coming" : "now") as TrendItem["tense"],
          window: WINDOW_BY_MOMENTUM[momentum],
          evidence: strip(t.evidence),
          competitors: Array.isArray(t.competitors) ? t.competitors.map(strip).filter(Boolean).slice(0, 5) : [],
          yourMove: strip(t.yourMove),
        };
      }).filter((t) => t.topic);
      if (trends.length) {
        if (!summaryStr) summaryStr = `${trends.slice(0, 3).map((t) => t.topic).join(" · ")} are catching on locally right now.`;
        return { summary: summaryStr, trends, at };
      }
    } catch { /* transient — retry */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
  }
  // Couldn't get real trends — mark failed so warm-up retries rather than caching empty.
  return { summary: "", trends: [], empty: true, failed: true, at };
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
