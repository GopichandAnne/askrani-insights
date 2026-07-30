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
};

export default nextConfig;
