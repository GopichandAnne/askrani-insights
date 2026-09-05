/** Client-safe attention-preference constants — shared by the attention layer
 *  (server) and the /brief controls (client). No imports, so it's safe in both. */
export type AttnMode = "quiet" | "balanced" | "active";

export const OBJECTIVES: { slug: string; label: string }[] = [
  { slug: "protect_margin", label: "Protect margin" },
  { slug: "more_traffic", label: "More traffic" },
  { slug: "grow_sales", label: "Grow sales" },
  { slug: "more_reviews", label: "More & better reviews" },
  { slug: "get_discovered", label: "Get discovered" },
];

export const MODES: { slug: AttnMode; label: string; hint: string }[] = [
  { slug: "quiet", label: "Quiet", hint: "Only high-impact" },
  { slug: "balanced", label: "Balanced", hint: "The 2–4 that matter" },
  { slug: "active", label: "Active", hint: "The fuller picture" },
];

export const objectiveLabel = (slug?: string): string | null =>
  OBJECTIVES.find((o) => o.slug === slug)?.label ?? null;
