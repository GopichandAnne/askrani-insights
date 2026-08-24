import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { findSocialHandles, findDeliveryUrls, reverseGeoCity, isGenericHandle } from "@/lib/social-discovery";
import { extractCity } from "@/lib/news";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Confirm-your-profiles step. Before the scan runs, we DISCOVER the business's
 * own online profiles (website + Instagram/Facebook/TikTok + DoorDash/UberEats)
 * and hand them back so the owner can validate/correct them — instead of the old
 * flow, which guessed them silently DURING the scan and attached wrong same-name
 * accounts with no chance to fix. Saving writes exactly the owner's confirmed set
 * and marks discovery "resolved" so the scan trusts it rather than re-guessing.
 */

// The platforms the owner confirms here. Everything else on the business
// (google place_id, yelp, news…) is left untouched by the save.
const CONFIRMABLE = ["website", "instagram", "facebook", "tiktok", "doordash", "ubereats"] as const;
type Platform = (typeof CONFIRMABLE)[number];
const SOCIAL: Platform[] = ["instagram", "facebook", "tiktok"];
const DELIVERY: Platform[] = ["doordash", "ubereats"];

async function loadTarget(workspaceId: string, orgId: string) {
  const svc = createServiceClient();
  const { data: ws } = await svc
    .from("workspace")
    .select("id,organization_id,target_business_id,vertical")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws || ws.organization_id !== orgId || !ws.target_business_id) return null;
  const { data: biz } = await svc
    .from("business")
    .select("id,canonical_name,vertical,website,attributes")
    .eq("id", ws.target_business_id)
    .maybeSingle();
  if (!biz) return null;
  return { svc, ws, biz, attrs: (biz.attributes as any) ?? {} };
}

export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId ?? "");
  if (!workspaceId) return badRequest("workspaceId required");

  const ctx = await loadTarget(workspaceId, auth.orgId);
  if (!ctx) return badRequest("workspace not found");
  const { svc, biz, attrs } = ctx;
  const vertical = (biz.vertical as string) || (ctx.ws.vertical as string) || "";
  const foodVertical = vertical === "restaurant" || vertical === "grocery";

  // ── SAVE: persist the owner's confirmed profiles, replacing only the
  //    confirmable platforms, then mark discovery resolved so the scan trusts it.
  if (body?.mode === "save") {
    const incoming = (body?.profiles ?? {}) as Record<string, string>;
    for (const platform of CONFIRMABLE) {
      const raw = String(incoming[platform] ?? "").trim();
      await svc.from("external_identity").delete().eq("business_id", biz.id).eq("platform", platform);
      if (raw) {
        const url = normalizeUrl(platform, raw);
        if (url) await svc.from("external_identity").insert({ business_id: biz.id, platform, url, verification_state: "owner_verified" }).then(() => {}, () => {});
      }
    }
    const website = String(incoming.website ?? "").trim();
    const websiteUrl = website ? normalizeUrl("website", website) : null;
    await svc
      .from("business")
      .update({
        // top-level column is what the scan's crawler reads — mirror it here so
        // an owner's website edit actually takes effect.
        ...(websiteUrl ? { website: websiteUrl } : {}),
        attributes: {
          ...attrs,
          ...(websiteUrl ? { website: websiteUrl } : {}),
          social_resolved: true,   // owner confirmed → scan won't re-guess socials
          delivery_resolved: true, // owner confirmed → scan won't re-guess delivery
          ...(websiteUrl ? { web_resolved: true } : {}), // don't override owner's site; but still allow Google-borrow when they gave none
          profiles_confirmed_at: new Date().toISOString(),
        },
      })
      .eq("id", biz.id);
    return NextResponse.json({ saved: true });
  }

  // ── DISCOVER: return what's already attached + freshly-found suggestions so
  //    the owner can confirm/correct each channel before anything is scanned.
  const { data: identRows } = await svc
    .from("external_identity")
    .select("platform,url,handle,verification_state")
    .eq("business_id", biz.id);
  const attached = new Map<string, { url: string; state: string }>();
  for (const r of identRows ?? []) {
    const p = (r as any).platform as string;
    const u = (r as any).url ?? (r as any).handle;
    if (CONFIRMABLE.includes(p as Platform) && u && !attached.has(p)) attached.set(p, { url: u, state: (r as any).verification_state ?? "observed" });
  }
  const knownWebsite = (biz.website as string | null) || (attrs.website as string | undefined);
  if (knownWebsite && !attached.has("website")) attached.set("website", { url: knownWebsite, state: "auto_verified" });

  // City signal for location-aware matching (same guard the scan uses).
  let city = extractCity(attrs.address as string | undefined) || "";
  const geo = attrs.geo as { lat: number; lng: number } | undefined;
  if (!city && geo) city = await reverseGeoCity(geo);

  // Only search for channels we don't already have. Run social + delivery in
  // parallel to keep the step snappy. No city → skip name discovery (can't
  // disambiguate same-name accounts) rather than risk a wrong attach.
  const wantSocial = { instagram: !attached.has("instagram"), facebook: !attached.has("facebook"), tiktok: !attached.has("tiktok") };
  const wantDelivery = { doordash: !attached.has("doordash"), ubereats: !attached.has("ubereats") };
  const anySocial = Object.values(wantSocial).some(Boolean);
  const anyDelivery = foodVertical && Object.values(wantDelivery).some(Boolean);

  const [social, delivery] = await Promise.all([
    city && anySocial ? findSocialHandles(biz.canonical_name, city, wantSocial, { website: knownWebsite, city }).catch(() => null) : Promise.resolve(null),
    city && anyDelivery ? findDeliveryUrls(biz.canonical_name, city, wantDelivery).catch(() => null) : Promise.resolve(null),
  ]);

  // confidence: "high" = backlink/owner-verified (trust); "medium" = name+geo match
  // (owner should confirm). Drives the ✓/"check this" hint in the confirm card.
  type Conf = "high" | "medium";
  const profiles: Record<Platform, { url: string; source: "attached" | "found" | ""; confidence?: Conf }> = {} as any;
  for (const p of CONFIRMABLE) {
    if (attached.has(p)) {
      const a = attached.get(p)!;
      profiles[p] = { url: a.url, source: "attached", confidence: a.state === "owner_verified" || a.state === "auto_verified" ? "high" : "medium" };
      continue;
    }
    let url = ""; let confidence: Conf | undefined;
    if (SOCIAL.includes(p)) { const u = (social as any)?.[p]; if (u && !isGenericHandle(u)) { url = u; confidence = (social as any)?.confidence?.[p] ?? "medium"; } }
    else if (DELIVERY.includes(p)) { const u = (delivery as any)?.[p]; if (u) { url = u; confidence = "medium"; } }
    profiles[p] = { url, source: url ? "found" : "", ...(url ? { confidence } : {}) };
  }

  return NextResponse.json({ profiles, foodVertical, city });
}

/** Light normalization: bare handles → full URLs; ensure a scheme on websites. */
function normalizeUrl(platform: Platform, raw: string): string {
  const v = raw.trim();
  if (platform === "website") return /^https?:\/\//i.test(v) ? v : `https://${v.replace(/^\/+/, "")}`;
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, "").replace(/\/+$/, "");
  if (platform === "instagram") return `https://www.instagram.com/${handle}`;
  if (platform === "facebook") return `https://www.facebook.com/${handle}`;
  if (platform === "tiktok") return `https://www.tiktok.com/@${handle}`;
  return v; // doordash/ubereats must be full store URLs
}
