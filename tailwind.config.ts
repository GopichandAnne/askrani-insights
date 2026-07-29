import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0f172a",
          soft: "#334155",
          faint: "#64748b",
        },
        surface: {
          DEFAULT: "#ffffff",
          sunken: "#f8fafc",
          raised: "#ffffff",
        },
        line: "#e2e8f0",
        brand: {
          DEFAULT: "#4f46e5",
          soft: "#eef2ff",
        },
        // Confidence / provenance semantics — used consistently across the UI
        // so "how sure are we, and from where" is always legible (guide 6.4, 13.2).
        trust: {
          direct: "#059669", // directly observed
          corroborated: "#0284c7", // cross-source confirmed
          inferred: "#d97706", // model inference
          low: "#dc2626", // low confidence / needs review
        },
      },
    },
  },
  plugins: [],
};

export default config;
