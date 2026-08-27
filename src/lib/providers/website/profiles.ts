import * as cheerio from "cheerio";

/**
 * Profile resolver — discover all of a business's platform profiles from its own
 * website (JSON-LD `sameAs` + on-page links). Reading a business's own published
 * links is clean/legitimate; it's what lets collection auto-target whatever
 * platforms a given business actually uses ("intelligently, for any business").
 */

export interface ProfileLink {
  platform: string;
  url: string;
}

// platform → matcher on a URL's host/path. Order matters (first match wins).
const PLATFORMS: Array<{ platform: string; re: RegExp }> = [
  { platform: "instagram", re: /(^|\.)instagram\.com\// },
  { platform: "facebook", re: /(^|\.)facebook\.com\/|(^|\.)fb\.com\// },
  { platform: "tiktok", re: /(^|\.)tiktok\.com\// },
  { platform: "youtube", re: /(^|\.)youtube\.com\/|(^|\.)youtu\.be\// },
  { platform: "twitter", re: /(^|\.)twitter\.com\/|(^|\.)x\.com\// },
  { platform: "doordash", re: /(^|\.)doordash\.com\// },
  { platform: "ubereats", re: /(^|\.)ubereats\.com\// },
  { platform: "grubhub", re: /(^|\.)grubhub\.com\// },
  { platform: "yelp", re: /(^|\.)yelp\.com\/biz\// },
  // Healthcare review directories (dental/medical) — a "Book on Zocdoc" / "Reviews
  // on Healthgrades" link on the practice's own site is the strongest signal of
  // its real profile URL, so the directory readers can target it automatically.
  { platform: "zocdoc", re: /(^|\.)zocdoc\.com\/(practice|dentist|doctor|provider)\// },
  { platform: "healthgrades", re: /(^|\.)healthgrades\.com\/(dentist|physician|providers)\// },
  // Online-booking platforms (salons / med spas / wellness) — a link here is a
  // real "Book now" page, more useful to surface than the plain website.
  { platform: "booking", re: /(^|\.)(vagaro|boulevard|blvd\.co|glossgenius|mindbody(online)?|acuityscheduling|squarespace-scheduling|setmore|gettimely|timelyapp|zenoti|aestheticrecord|withcherry|gocherry|booksy|phorest|fresha|schedulicity|janeapp|book\.squareup)\.com\// },
];

// Links that are share/intent/generic, not a business's own profile.
const NOISE = /\/(sharer|share|intent|dialog|plugins|login|home|help|policies|about|tos|privacy)\b|\/hashtag\/|[?&]url=/i;

function classify(url: string): string | undefined {
  const lower = url.toLowerCase();
  if (NOISE.test(lower)) return undefined;
  for (const p of PLATFORMS) if (p.re.test(lower)) return p.platform;
  return undefined;
}

function clean(url: string): string {
  // strip query/fragment/trailing slash for a stable identity
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function extractProfileLinks(html: string, baseUrl: string): ProfileLink[] {
  const $ = cheerio.load(html);
  const found = new Map<string, string>(); // platform → url (first/shortest wins)

  const consider = (raw?: string) => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch {
      return;
    }
    const platform = classify(abs);
    if (!platform) return;
    const url = clean(abs);
    const existing = found.get(platform);
    if (!existing || url.length < existing.length) found.set(platform, url);
  };

  // 1) JSON-LD sameAs (the canonical, structured signal)
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt.trim()) return;
    try {
      const walk = (node: any) => {
        if (!node || typeof node !== "object") return;
        const same = node.sameAs;
        if (same) (Array.isArray(same) ? same : [same]).forEach((s: any) => consider(String(s)));
        for (const v of Object.values(node)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") walk(v);
        }
      };
      walk(JSON.parse(txt));
    } catch {
      /* ignore bad JSON-LD */
    }
  });

  // 2) on-page anchors (footer/header social icons, "order on DoorDash", etc.)
  $("a[href]").each((_, el) => consider($(el).attr("href")));

  return [...found.entries()].map(([platform, url]) => ({ platform, url }));
}
