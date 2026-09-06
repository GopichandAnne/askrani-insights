import type { MetadataRoute } from "next";

const APP = (process.env.NEXT_PUBLIC_APP_URL || "https://insights.askrani.ai").replace(/\/$/, "");

/** Allow all crawlers (incl. AI bots: GPTBot, OAI-SearchBot, PerplexityBot,
 *  ClaudeBot, Google-Extended) so published /m/ listings can be fetched + cited;
 *  authed app routes just serve the login wall to bots. Declares the sitemap. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${APP}/sitemap.xml`,
  };
}
