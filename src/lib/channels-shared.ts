/**
 * Client-safe channel types + constants (no server imports). Shared by the
 * Channels UI (client) and the server-side channels helpers/API routes.
 */

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "youtube"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const PLATFORM_META: Record<string, { label: string; icon: string; social: boolean; placeholder: string }> = {
  instagram: { label: "Instagram", icon: "📸", social: true, placeholder: "instagram.com/yourhandle" },
  facebook: { label: "Facebook", icon: "👍", social: true, placeholder: "facebook.com/yourpage" },
  tiktok: { label: "TikTok", icon: "🎵", social: true, placeholder: "tiktok.com/@yourhandle" },
  youtube: { label: "YouTube", icon: "▶️", social: true, placeholder: "youtube.com/@yourchannel" },
  website: { label: "Website", icon: "🌐", social: false, placeholder: "yourbusiness.com" },
  google: { label: "Google", icon: "📍", social: false, placeholder: "Google Business Profile" },
  yelp: { label: "Yelp", icon: "⭐", social: false, placeholder: "yelp.com/biz/…" },
};

export interface ChannelIdentity {
  id: string;
  platform: string;
  url: string | null;
  handle: string | null;
  verification_state: string;
  posts: number;
  lastAt: string | null;
}
export interface BusinessChannels {
  businessId: string;
  name: string;
  isTarget: boolean;
  website: string | null;
  identities: ChannelIdentity[];
  socialCount: number; // # of social platforms monitored
}

/** Normalize a pasted handle/URL into a canonical platform URL + bare handle. */
export function normalizeSocial(platform: string, raw: string): { url: string; handle: string } | null {
  const v = raw.trim();
  if (!v) return null;
  const host: Record<string, string> = {
    instagram: "instagram.com",
    facebook: "facebook.com",
    tiktok: "tiktok.com",
    youtube: "youtube.com",
  };
  if (platform === "website") {
    const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    try { return { url, handle: new URL(url).host.replace(/^www\./, "") }; } catch { return null; }
  }
  const h = host[platform];
  if (!h) {
    const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    return { url, handle: v };
  }
  // accept a full URL, @handle, or bare handle
  let handle = v;
  const m = v.match(new RegExp(`${h.replace(".", "\\.")}/(@?[A-Za-z0-9_.\\-]+)`, "i"));
  if (m) handle = m[1];
  handle = handle.replace(/^@/, "").replace(/\/.*$/, "");
  if (!handle) return null;
  const slug = platform === "tiktok" || platform === "youtube" ? `@${handle}` : handle;
  return { url: `https://www.${h}/${slug}`, handle };
}
