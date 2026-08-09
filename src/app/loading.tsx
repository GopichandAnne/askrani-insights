import { BrandLoader } from "@/components/BrandLoader";

/** Branded route-transition mask (App Router shows this during data fetch) —
 *  matches app.askrani.ai's loading mask (spinning ring + bobbing Rani). */
export default function Loading() {
  return <BrandLoader label="Loading your market intelligence…" />;
}
