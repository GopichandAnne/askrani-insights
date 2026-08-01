import { createClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { SOCIAL_PLATFORMS, type ChannelIdentity, type BusinessChannels } from "@/lib/channels-shared";

/**
 * "Channels" = every public source we watch for a business (its social handles,
 * website, listings). Owners need to SEE what's monitored and fix it when our
 * automatic handle-mapping misses (esp. ethnic grocers who live on Instagram).
 * Client-safe constants/types/helpers live in ./channels-shared (re-exported).
 */

export { SOCIAL_PLATFORMS, PLATFORM_META, normalizeSocial } from "@/lib/channels-shared";
export type { SocialPlatform, ChannelIdentity, BusinessChannels } from "@/lib/channels-shared";

const SOCIAL_SET = new Set<string>(SOCIAL_PLATFORMS);

export async function workspaceChannels(ws: WorkspaceRow): Promise<BusinessChannels[]> {
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws);
  const scope = ids.all;
  if (!scope.length) return [];

  const [{ data: biz }, { data: idents }, { data: posts }] = await Promise.all([
    supabase.from("business").select("id,canonical_name,website").in("id", scope),
    supabase.from("external_identity").select("id,business_id,platform,url,handle,verification_state").in("business_id", scope),
    supabase.from("content_item").select("business_id,platform,observed_at,published_at").in("business_id", scope).limit(4000),
  ]);

  // aggregate collected posts per (business, platform)
  const agg = new Map<string, { n: number; last: number }>();
  for (const p of posts ?? []) {
    const key = `${(p as any).business_id}|${(p as any).platform}`;
    const t = (p as any).published_at || (p as any).observed_at;
    const ms = t ? Date.parse(t) : 0;
    const cur = agg.get(key) ?? { n: 0, last: 0 };
    cur.n++;
    cur.last = Math.max(cur.last, ms);
    agg.set(key, cur);
  }

  const identsByBiz = new Map<string, ChannelIdentity[]>();
  for (const it of idents ?? []) {
    const bid = (it as any).business_id as string;
    const key = `${bid}|${(it as any).platform}`;
    const a = agg.get(key);
    const row: ChannelIdentity = {
      id: (it as any).id,
      platform: (it as any).platform,
      url: (it as any).url,
      handle: (it as any).handle,
      verification_state: (it as any).verification_state,
      posts: a?.n ?? 0,
      lastAt: a?.last ? new Date(a.last).toISOString() : null,
    };
    const arr = identsByBiz.get(bid) ?? [];
    arr.push(row);
    identsByBiz.set(bid, arr);
  }

  const nameById = new Map((biz ?? []).map((b: any) => [b.id, b]));
  const rank = (p: string) => (SOCIAL_SET.has(p) ? 0 : p === "website" ? 1 : 2);

  return scope
    .map((bid) => {
      const b = nameById.get(bid);
      const identities = (identsByBiz.get(bid) ?? []).sort((a, b2) => rank(a.platform) - rank(b2.platform) || b2.posts - a.posts);
      return {
        businessId: bid,
        name: b?.canonical_name ?? "Business",
        isTarget: bid === ids.targetId,
        website: b?.website ?? null,
        identities,
        socialCount: identities.filter((i) => SOCIAL_SET.has(i.platform)).length,
      };
    })
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || a.name.localeCompare(b.name));
}

/** Confirm the caller may manage a business (it's in one of their workspaces). */
export async function canManageBusiness(businessId: string): Promise<boolean> {
  const supabase = await createClient();
  // target of a workspace they're a member of…
  const { data: asTarget } = await supabase.from("workspace").select("id").eq("target_business_id", businessId).limit(1);
  if (asTarget?.length) return true;
  // …or a competitor in one of their workspaces (RLS scopes competitor_edge)
  const { data: asEdge } = await supabase.from("competitor_edge").select("id").eq("competitor_id", businessId).limit(1);
  return !!asEdge?.length;
}
