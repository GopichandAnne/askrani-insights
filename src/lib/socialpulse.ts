import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Social PULSE — the time-derivative of the local content scene, mirroring the
 * review pulse. What's CHANGING in rivals' social, not the static state:
 *   • breakouts   — a rival post whose engagement spiked vs THAT rival's own
 *                   baseline (deterministic, grounded — no LLM needed)
 *   • rising/fading formats — content formats/themes gaining or dropping vs the
 *                   last snapshot (LLM diff against goals.socialThemeHistory)
 *   • new collabs — @accounts newly appearing in rival posts (deterministic diff)
 * Feeds the weekly digest (push) + the Content page. Hardened like the other LLM
 * pillars (failed flag, no-cache-on-failure, retry) — but breakouts/collabs still
 * populate even when the LLM (formats) is down.
 */

const SOCIAL = ["instagram", "facebook", "tiktok", "youtube"];
const metricsOf = (m: unknown) => (Array.isArray(m) ? (m.find((x) => (x as { type?: string })?.type === "metrics") as { views?: number; likes?: number; comments?: number } | undefined) : undefined);
const engOf = (mm?: { views?: number; likes?: number; comments?: number }) => (mm?.views || 0) + (mm?.likes || 0) * 3 + (mm?.comments || 0) * 5;
const MENTION_RE = /(?:^|[^\w@])@([a-z0-9._]{2,30})\b/gi;
const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();

export interface Breakout { rival: string; caption: string; url?: string; eng: number; multiple: number }
export interface SocialPulse {
  breakouts: Breakout[];
  risingFormats: string[];
  fadingFormats: string[];
  newCollabs: string[];
  summary: string;
  at: string;
  empty?: boolean;
  failed?: boolean;
}
interface SocialSnapshot { d: string; formats: string[]; mentions: string[] }

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    formats: {
      type: "array", description: "Current content formats/themes rivals are posting (4–8), grounded ONLY in the posts given.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          format: { type: "string", description: "The format/theme in a few words, e.g. 'before/after reels', 'chef POV', 'festival promos', 'customer testimonials'." },
          trend: { type: "string", enum: ["new", "growing", "steady"], description: "vs the PREVIOUS formats list: new = not seen before, growing = more of it than before, steady = about the same." },
        },
        required: ["format", "trend"],
      },
    },
    faded: { type: "array", items: { type: "string" }, description: "Previous formats that rivals have largely stopped posting." },
    summary: { type: "string", description: "1–2 plain sentences: what's CHANGING in the local content scene right now (not a static description)." },
  },
  required: ["formats", "faded", "summary"],
};
const SYSTEM =
  "You track how a local market's SOCIAL CONTENT is changing over time. Given the previous formats and the current top rival posts (with engagement numbers), list the current formats/themes with whether each is new/growing/steady vs before, which faded, and one or two sentences on what's shifting. Ground everything ONLY in the posts provided — never invent. Plain, concrete language.";

const empty = (at: string, failed = false): SocialPulse => ({ breakouts: [], risingFormats: [], fadingFormats: [], newCollabs: [], summary: "", at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateSocialPulse(ws: WorkspaceRow, db?: RlsClient): Promise<SocialPulse> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.competitorIds.length) return empty(at);

  const { data: posts } = await supabase
    .from("content_item")
    .select("text, platform, media, url, published_at, observed_at, business:business_id(canonical_name)")
    .in("business_id", ids.competitorIds)
    .in("platform", SOCIAL)
    .order("observed_at", { ascending: false })
    .limit(600);

  const all = (posts ?? []).map((p) => {
    const mm = metricsOf((p as any).media);
    return {
      rival: (p as any).business?.canonical_name ?? "A rival",
      caption: clean((p as any).text),
      url: (p as any).url ?? undefined,
      eng: engOf(mm),
      date: (p as any).published_at ?? (p as any).observed_at ?? null,
    };
  }).filter((p) => p.caption.length > 4);
  if (all.length < 5) return empty(at);

  // ── breakouts: post engagement vs the SAME rival's baseline (deterministic) ──
  const byRival = new Map<string, number[]>();
  for (const p of all) { const a = byRival.get(p.rival) ?? []; a.push(p.eng); byRival.set(p.rival, a); }
  const baseline = new Map<string, number>();
  for (const [r, es] of byRival) { const s = [...es].sort((a, b) => a - b); baseline.set(r, s[Math.floor(s.length / 2)] || 0); } // median
  const cutoff = Date.parse(at) - 21 * 86_400_000;
  let recent = all.filter((p) => p.date && Date.parse(p.date) >= cutoff);
  if (recent.length < 3) recent = all.slice(0, 40); // dates sparse → most-recently-seen
  const breakouts: Breakout[] = recent
    .map((p) => ({ rival: p.rival, caption: p.caption.slice(0, 160), url: p.url, eng: p.eng, multiple: Number((p.eng / Math.max(baseline.get(p.rival) || 0, 50)).toFixed(1)) }))
    .filter((b) => b.eng >= 150 && b.multiple >= 2.5)
    .sort((a, b) => b.multiple - a.multiple);
  // at most one breakout per rival, top 3
  const seenRival = new Set<string>();
  const topBreakouts = breakouts.filter((b) => (seenRival.has(b.rival) ? false : (seenRival.add(b.rival), true))).slice(0, 3);

  // ── @mentions now vs last snapshot → new collab candidates (deterministic) ──
  const mentionSet = new Set<string>();
  for (const p of all) for (const m of p.caption.matchAll(MENTION_RE)) { const h = m[1].toLowerCase().replace(/\.+$/, ""); if (h.length >= 2) mentionSet.add(h); }
  const { data: gRow } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (gRow?.goals as Record<string, any>) ?? {};
  const prevSnap = (goals.socialThemeHistory as SocialSnapshot[] | undefined)?.slice(-1)[0];
  const prevMentions = new Set(prevSnap?.mentions ?? []);
  const prevFormats = prevSnap?.formats ?? [];
  const newCollabs = prevSnap ? [...mentionSet].filter((h) => !prevMentions.has(h)).slice(0, 6) : [];

  // ── format velocity (LLM diff) — deterministic parts stand even if this fails ──
  let risingFormats: string[] = [], fadingFormats: string[] = [], summary = "", curFormats: string[] = [], failed = false;
  if (isLlmConfigured()) {
    const topPosts = [...all].sort((a, b) => b.eng - a.eng).slice(0, 30).map((p) => `${p.rival} (${p.eng} eng): ${p.caption.slice(0, 160)}`).join("\n");
    const text =
      `Business: "${ws.name}" (${ws.vertical}). What's changing in the local content scene?\n\n` +
      `PREVIOUS FORMATS (last check): ${prevFormats.length ? prevFormats.join(", ") : "(none captured yet — first read)"}\n\n` +
      `TOP LOCAL RIVAL POSTS BY ENGAGEMENT:\n${topPosts}`;
    try {
      const call = () => getLlm().callStructured<{ formats: any[]; faded: any[]; summary: string }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 900 });
      const { data } = await call().catch(() => call());
      const fmts = (Array.isArray(data.formats) ? data.formats : []).map((f) => ({ format: clean(f.format), trend: clean(f.trend) || "steady" })).filter((f) => f.format);
      curFormats = fmts.map((f) => f.format);
      risingFormats = fmts.filter((f) => f.trend === "new" || f.trend === "growing").map((f) => f.format).slice(0, 5);
      fadingFormats = (Array.isArray(data.faded) ? data.faded : []).map(clean).filter(Boolean).slice(0, 4);
      summary = clean(data.summary);
    } catch {
      failed = true;
    }
  }

  if (!topBreakouts.length && !risingFormats.length && !newCollabs.length && !summary) {
    return failed ? empty(at, true) : empty(at);
  }
  if (!summary && topBreakouts[0]) summary = `${topBreakouts[0].rival}'s post is breaking out (${topBreakouts[0].multiple}× their usual engagement).`;

  // roll the snapshot (formats + mentions) for next cycle's diff — only when the
  // LLM produced formats (else keep prior formats so we don't lose the baseline)
  const snap: SocialSnapshot = { d: at.slice(0, 10), formats: curFormats.length ? curFormats : prevFormats, mentions: [...mentionSet].slice(0, 100) };
  const history = [ ...((goals.socialThemeHistory as SocialSnapshot[] | undefined) ?? []).filter((h) => h.d !== snap.d), snap ].slice(-12);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), socialThemeHistory: history } }).eq("id", ws.id).then(() => {}, () => {});

  return { breakouts: topBreakouts, risingFormats, fadingFormats, newCollabs, summary, at, ...(failed ? { failed: true } : {}) };
}

export function socialPulseIsGood(p: SocialPulse): boolean {
  if (p.failed) return false;
  return !!(p.breakouts.length || p.risingFormats.length || p.newCollabs.length || p.summary || p.empty);
}

export async function getOrMakeSocialPulse(ws: WorkspaceRow, maxAgeHours = 12): Promise<SocialPulse> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as { socialPulse?: SocialPulse } | null)?.socialPulse;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && !cached.failed) return cached;

  const fresh = await generateSocialPulse(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as any) ?? {}), socialPulse: fresh } }).eq("id", ws.id);
  return fresh;
}
