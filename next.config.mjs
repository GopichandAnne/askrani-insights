/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the headless-browser packages out of the server bundle (native/large).
  // On Vercel serverless there's no installed Chrome, so rendering degrades to
  // static crawling gracefully; add @sparticuz/chromium later to enable it.
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  experimental: {
    // server actions body size — flyer/menu uploads can be large
    serverActions: { bodySizeLimit: "10mb" },
  },
  images: {
    // Public competitor media is loaded from many hosts; we only ever render
    // thumbnails/evidence we are permitted to display (see guide 13.1 copyright/media).
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // Allow the Ask Rani host to embed Insights in an iframe — but ONLY that origin
  // (clickjacking-safe). Set EMBED_ORIGIN (e.g. https://app.askrani.ai) in the
  // Insights project's env. When unset, the browser default (same-origin) applies
  // and no one can frame us.
  async headers() {
    const embed = process.env.EMBED_ORIGIN;
    if (!embed) return [];
    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors 'self' ${embed}` }],
      },
    ];
  },
};

export default nextConfig;
