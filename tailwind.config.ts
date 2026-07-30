import type { Config } from "tailwindcss";

/**
 * Ask Rani Insights — theme matched EXACTLY to the Ask Rani platform tokens
 * (askrani-web/app/tokens.css: teal primary, coral accent, cream, navy;
 * DM Sans body + Playfair Display display). Token names are kept stable so the
 * whole app reskins by remapping values here.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        display: ['"Playfair Display"', "Georgia", "serif"],
      },
      colors: {
        // brand: teal (Ask Rani primary)
        brand: {
          DEFAULT: "#14b8a6",
          dark: "#0d9488",
          deep: "#0f766e",
          light: "#5eead4",
          soft: "#f0fdfa", // teal-mist
          border: "#ccfbf1",
        },
        coral: { DEFAULT: "#fb923c", dark: "#f97316" },
        ink: {
          DEFAULT: "#1f2937", // text
          soft: "#374151",
          faint: "#6b7280", // muted
        },
        surface: {
          DEFAULT: "#ffffff",
          sunken: "#fafaf8", // cream
          raised: "#ffffff",
        },
        line: "#e5e7eb",
        navy: {
          DEFAULT: "#0c1222",
          surface: "#141b2e",
          border: "#1e293b",
        },
        // confidence / provenance semantics (kept, tuned on-brand)
        trust: {
          direct: "#0f766e", // teal-deep — directly observed
          corroborated: "#0284c7",
          inferred: "#d97706",
          low: "#dc2626",
        },
      },
      borderRadius: {
        DEFAULT: "12px",
        lg: "16px",
        xl: "20px",
      },
      boxShadow: {
        brand: "0 4px 14px rgba(20, 184, 166, 0.3)",
        "brand-lg": "0 6px 20px rgba(20, 184, 166, 0.4)",
        card: "0 8px 24px rgba(0, 0, 0, 0.08)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #14b8a6, #0d9488)",
        "brand-hero": "linear-gradient(135deg, #0f766e, #14b8a6 50%, #0d9488)",
      },
    },
  },
  plugins: [],
};

export default config;
