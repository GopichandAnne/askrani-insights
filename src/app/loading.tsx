import { RaniSpinner } from "@/components/RaniSpinner";

/** Branded route-transition loader (App Router shows this during data fetch). */
export default function Loading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <RaniSpinner label="Loading your market intelligence…" />
    </div>
  );
}
