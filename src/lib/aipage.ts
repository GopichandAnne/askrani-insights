import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * AI-ready page — the credit-gated "get found by AI" add-on. We publish a clean,
 * SERVER-RENDERED public page per business from data we already hold (menu/products
 * + prices, hours, address, a review takeaway, a real FAQ). Built to the evidence:
 * AI crawlers read VISIBLE HTML (not JSON-LD, not llms.txt) and don't run JS — so the
 * facts live in plain text; JSON-LD rides along only as a classic indexing aid. It's
 * a controllable, always-fresh, indexable surface that complements GBP/Yelp — never a
 * substitute. Published only when the owner opts in (spends credits); content cached
 * on goals.aiPage, the public route renders it.
 */
/** Credits to publish/refresh the AI page (covers the grounded LLM generation). */
export const AIPAGE_PUBLISH_CREDITS = 10;

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const slugify = (s: string) => norm(s).replace(/\s+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");

export interface AiPageItem { name: string; price?: string }
export interface AiPageFaq { q: string; a: string }
export interface AiPage {
  slug: string;
  published: boolean;
  title: string;
  intro: string;              // direct-answer summary (first thing AI extracts)
  items: AiPageItem[];        // menu / products with prices
  faqs: AiPageFaq[];
  hours?: string | null;
  address?: string | null;
  website?: string | null;
  reviewTakeaway?: string | null;
  vertical?: string;
  updatedAt: string;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    intro: { type: "string", description: "2-4 plain sentences a customer (or an AI assistant) can lift verbatim: what this business is, its specialty, where it is, and what it's known for. Grounded ONLY in the facts given. Lead with the specifics." },
    faqs: {
      type: "array", minItems: 3, maxItems: 6,
      description: "Real customer questions this page should answer (dietary/vegan/halal, hours, catering/delivery, parking, popular items, price range) — only ones the facts support.",
      items: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, a: { type: "string", description: "one concrete sentence, grounded in the facts" } }, required: ["q", "a"] },
    },
  },
  required: ["intro", "faqs"],
};
const SYSTEM =
  "You write a concise, factual public listing for a local business so both people and AI assistants can find it by its products and attributes. Use ONLY the facts provided (name, category, location, menu/products + prices, hours, review themes). Be specific and plain — no marketing fluff, no invented facts. The intro should read like a clear answer to 'what is this place and what do they have'.";

export async function generateAiPage(ws: WorkspaceRow, db?: RlsClient): Promise<AiPage | null> {
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.targetId) return null;

  const { data: biz } = await supabase.from("business").select("canonical_name, website, attributes").eq("id", ids.targetId).maybeSingle();
  if (!biz) return null;
  const attrs = (biz.attributes as any) ?? {};
  const address = clean(attrs.address) || null;
  const city = extractCity(address);
  const reviewTakeaway = clean(attrs.googleReviewSummary?.text) || null;

  // own priced offerings (deduped, most recent), the products people search by
  const { data: offers } = await supabase.from("offer").select("entity_text, pricing").eq("business_id", ids.targetId).order("observed_at", { ascending: false }).limit(400);
  const seen = new Set<string>();
  const items: AiPageItem[] = [];
  for (const o of (offers ?? []) as any[]) {
    const name = clean(o.entity_text); if (!name) continue;
    const k = norm(name); if (seen.has(k)) continue; seen.add(k);
    const amt = Number(o.pricing?.amount);
    items.push({ name, price: Number.isFinite(amt) && amt > 0 ? `$${amt.toFixed(2)}` : undefined });
    if (items.length >= 40) break;
  }

  const title = `${clean(biz.canonical_name)}${city ? ` — ${city}` : ""}`;
  let intro = "";
  let faqs: AiPageFaq[] = [];
  if (isLlmConfigured()) {
    const text = `Business: "${clean(biz.canonical_name)}" (${ws.vertical}).\n` +
      (address ? `Location: ${address}.\n` : "") +
      (items.length ? `Menu/products (name — price):\n${items.slice(0, 30).map((i) => `- ${i.name}${i.price ? ` — ${i.price}` : ""}`).join("\n")}\n` : "") +
      (reviewTakeaway ? `What reviewers say: ${reviewTakeaway}\n` : "");
    try {
      const { data } = await getLlm().callStructured<{ intro: string; faqs: any[] }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 1500 });
      intro = clean(data.intro);
      faqs = (Array.isArray(data.faqs) ? data.faqs : []).map((f) => ({ q: clean(f.q), a: clean(f.a) })).filter((f) => f.q && f.a).slice(0, 6);
    } catch { /* fall through to a deterministic intro */ }
  }
  if (!intro) intro = `${clean(biz.canonical_name)} is a ${ws.vertical}${city ? ` in ${city}` : ""}.${items.length ? ` Offerings include ${items.slice(0, 5).map((i) => i.name).join(", ")}.` : ""}`;

  return {
    slug: "", published: false, title, intro, items, faqs,
    hours: clean(attrs.hours) || null, address, website: biz.website ?? null,
    reviewTakeaway, vertical: ws.vertical, updatedAt: new Date().toISOString(),
  };
}

function extractCity(address?: string | null): string | null {
  if (!address) return null;
  // "..., Cedar Park, TX 78613" → "Cedar Park"
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2].replace(/\b[A-Z]{2}\b.*$/, "").trim() || parts[parts.length - 2] : null;
}

/** Resolve a public slug → its published page (service client; public data). */
export async function getPublishedAiPage(slug: string): Promise<{ page: AiPage } | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("goals->>aiPageSlug", slug).maybeSingle();
  const page = (data?.goals as any)?.aiPage as AiPage | undefined;
  if (!page || !page.published) return null;
  return { page };
}

/** All published slugs — for the sitemap. */
export async function listPublishedSlugs(): Promise<{ slug: string; updatedAt: string }[]> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").not("goals->>aiPageSlug", "is", null).limit(5000);
  return ((data ?? []) as any[])
    .map((r) => r.goals?.aiPage as AiPage | undefined)
    .filter((p): p is AiPage => !!p && p.published && !!p.slug)
    .map((p) => ({ slug: p.slug, updatedAt: p.updatedAt }));
}

/** IndexNow ping (Bing/Yandex/etc.) — env-gated no-op until INDEXNOW_KEY is set +
 *  the key file is hosted at the domain root. Best-effort; never throws. */
export async function pingIndexNow(url: string): Promise<void> {
  const key = process.env.INDEXNOW_KEY;
  if (!key) return;
  try {
    const host = new URL(url).host;
    await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: [url] }),
    });
  } catch { /* best-effort */ }
}
