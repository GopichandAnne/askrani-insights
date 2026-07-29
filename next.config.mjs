/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
