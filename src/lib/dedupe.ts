/**
 * Cross-platform post dedup. Many businesses cross-post the SAME content to
 * Instagram, Facebook and TikTok (Meta's "post to both", schedulers), so the same
 * promo/caption lands as multiple content items — one per platform — and would be
 * double-counted in price hints, "what's winning", content ideas, etc. This
 * collapses near-identical captions from the SAME business across social platforms
 * into a single representative, keeping the highest-priority platform's copy.
 * Reviews and other non-social items pass through untouched (they're never mirrors).
 */

// Social platforms where the same post is commonly mirrored.
const SOCIAL = new Set(["instagram", "facebook", "tiktok", "youtube"]);
// When a caption is mirrored, keep the platform where organic activity is realest.
const PLATFORM_PRIORITY: Record<string, number> = { instagram: 4, tiktok: 3, youtube: 2, facebook: 1 };

/** Normalized dedup key: lowercase, drop URLs / #hashtags / @mentions (cross-posts
 *  often tweak only those), collapse to alphanumerics, take a stable prefix. */
export function crossPostKey(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\w.]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 140);
}

/**
 * Collapse cross-posted social items (same business, near-identical caption across
 * IG/FB/TikTok/YouTube) into one, keeping the highest-priority platform's copy.
 * Items need a platform, a text, and a business identifier (business_id, or a
 * nested business.canonical_name, or a business name). Order is otherwise preserved.
 */
export function dedupeCrossPost<T extends Record<string, any>>(items: T[]): T[] {
  const seen = new Map<string, number>(); // "biz|key" → index into out
  const out: T[] = [];
  const bizOf = (it: T): string =>
    String(it.business_id ?? it.business?.canonical_name ?? (typeof it.business === "string" ? it.business : "") ?? "");
  for (const it of items) {
    const platform = String(it.platform ?? "");
    const key = crossPostKey(it.text ?? "");
    // only collapse social posts with a substantive caption; everything else passes
    if (!SOCIAL.has(platform) || key.length < 12) { out.push(it); continue; }
    const dk = `${bizOf(it)}|${key}`;
    const idx = seen.get(dk);
    if (idx == null) { seen.set(dk, out.length); out.push(it); continue; }
    // duplicate caption → keep the higher-priority platform's copy in place
    const cur = out[idx];
    if ((PLATFORM_PRIORITY[platform] ?? 0) > (PLATFORM_PRIORITY[String(cur.platform)] ?? 0)) out[idx] = it;
  }
  return out;
}
