/**
 * Content-help need detection — the "intelligent layer decides" whether a suggestion
 * needs a PHOTO or a VIDEO (or neither), so we only surface the "have our team make
 * this" offer when there's a real visual-capture need. Uses the suggestion's own
 * format when it has one (content ideas carry reel/photo/carousel/story), else reads
 * the text. Returns null for text-only moves (replies, GBP edits) — no offer shown.
 * Client-safe (pure).
 */
export type CaptureKind = "video" | "photo";
export interface CaptureNeed { kind: CaptureKind; asset: string; output: string }

const VIDEO_RE = /\b(reel|video|tiktok|short|clip|film|montage|walkthrough)\b/i;
const PHOTO_RE = /\b(poster|flyer|photo|picture|image|carousel|story|post|banner|signage|shot)\b/i;

export function captureNeed(opts: { format?: string; text?: string }): CaptureNeed | null {
  const f = (opts.format || "").toLowerCase();
  if (f === "reel") return { kind: "video", asset: "a short clip", output: "reel" };
  if (f === "photo") return { kind: "photo", asset: "a photo", output: "post" };
  if (f === "carousel") return { kind: "photo", asset: "a few photos", output: "carousel" };
  if (f === "story") return { kind: "photo", asset: "a photo", output: "story" };
  const t = opts.text || "";
  if (VIDEO_RE.test(t)) return { kind: "video", asset: "a short clip", output: "reel" };
  if (PHOTO_RE.test(t)) return { kind: "photo", asset: "a photo", output: "post" };
  return null;
}
