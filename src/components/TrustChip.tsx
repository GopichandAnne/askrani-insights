/**
 * TrustChip — renders confidence + how a fact was established. Used everywhere
 * an observation appears, because "Evidence and confidence are product features"
 * (guide Final Build Principles). Never show a fact without one.
 */
export function TrustChip({
  confidence,
  inference = "direct",
}: {
  confidence: number;
  inference?: "direct" | "corroborated" | "inferred";
}) {
  const pct = Math.round(confidence * 100);
  const band =
    confidence >= 0.85 ? "high" : confidence >= 0.6 ? "medium" : "low";
  const color =
    band === "low"
      ? "bg-trust-low/10 text-trust-low"
      : inference === "inferred"
        ? "bg-trust-inferred/10 text-trust-inferred"
        : inference === "corroborated"
          ? "bg-trust-corroborated/10 text-trust-corroborated"
          : "bg-trust-direct/10 text-trust-direct";
  return (
    <span className={`chip ${color}`} title={`${inference} • ${pct}% confidence`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {pct}% · {inference}
    </span>
  );
}

export function ProvenanceBadge({ provenance }: { provenance: string }) {
  const label = provenance
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className="chip bg-surface-sunken text-ink-faint" title={provenance}>
      {label}
    </span>
  );
}
