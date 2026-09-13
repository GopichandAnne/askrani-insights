import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { findSocialHandles } from "@/lib/social-discovery";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // Instagram confirmation scrapes each candidate profile via Apify

/**
 * Intelligent, location-aware handle resolution for the monitoring queue. Runs the
 * app's own resolver (findSocialHandles): it searches "{name} {city} {platform}",
 * then an LLM picks the account for THIS business at THIS location and REJECTS
 * same-name accounts that belong to another metro — so a multi-location brand
 * resolves to its local store (e.g. @foodistaancp, not the national @foodistaan.us),
 * not the generic footer link a crawl would grab. Superadmin-only; needs the search
 * provider key (prod). Bounded per call (it does searches + LLM per business).
 */
const bare = (u?: string) => (u ? String(u).replace(/^https?:\/\/(www\.)?(instagram\.com|facebook\.com|tiktok\.com)\/@?/i, "").replace(/\/.*$/, "").trim() : "");

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  if (!isSuperAdmin(await getUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body.businesses) ? body.businesses : [];
  const businesses = raw
    .map((b: Record<string, unknown>) => ({
      id: String(b.id ?? ""),
      name: String(b.name ?? "").slice(0, 120).trim(),
      city: String(b.area ?? "").slice(0, 60).trim(),
      website: b.website ? String(b.website).slice(0, 300) : undefined,
    }))
    .filter((b: { id: string; name: string }) => b.id && b.name)
    .slice(0, 6); // bounded: each resolves via searches + LLM + Apify profile confirmation

  const results = await Promise.all(businesses.map(async (b: { id: string; name: string; city: string; website?: string }) => {
    try {
      const found = await findSocialHandles(b.name, b.city, { instagram: true, facebook: true, tiktok: true }, { website: b.website, city: b.city });
      const handles: Record<string, string> = {};
      for (const k of ["instagram", "facebook", "tiktok"] as const) { const h = bare(found[k]); if (h) handles[k] = h; }
      return { id: b.id, handles, confidence: found.confidence ?? {} };
    } catch (e) {
      return { id: b.id, handles: {}, error: (e as Error).message };
    }
  }));

  return NextResponse.json({ results });
}
