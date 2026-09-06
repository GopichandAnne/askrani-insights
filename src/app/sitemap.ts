import type { MetadataRoute } from "next";
import { listPublishedSlugs } from "@/lib/aipage";

const APP = (process.env.NEXT_PUBLIC_APP_URL || "https://insights.askrani.ai").replace(/\/$/, "");

/** Sitemap of published AI-ready listings, so crawlers discover them fast (paired
 *  with IndexNow on publish). Best-effort — never throws the build. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const slugs = await listPublishedSlugs();
    return slugs.map((s) => ({
      url: `${APP}/m/${s.slug}`,
      lastModified: new Date(s.updatedAt),
      changeFrequency: "weekly",
      priority: 0.7,
    }));
  } catch {
    return [];
  }
}
