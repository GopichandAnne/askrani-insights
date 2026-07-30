/**
 * TrustChip — shows how sure we are about a fact, in plain words a non-technical
 * owner understands ("Confirmed / Likely / Unconfirmed"), with the exact number
 * tucked into the tooltip. We still never hide uncertainty (guide principle),
 * we just say it human.
 */
export function TrustChip({
  confidence,
  inference = "direct",
}: {
  confidence: number;
  inference?: "direct" | "corroborated" | "inferred";
}) {
  const pct = Math.round(confidence * 100);
  const band = confidence >= 0.85 ? "high" : confidence >= 0.6 ? "medium" : "low";
  const label = band === "high" ? "Confirmed" : band === "medium" ? "Likely" : "Unconfirmed";
  const color =
    band === "low"
      ? "bg-trust-inferred/10 text-trust-inferred"
      : band === "medium"
        ? "bg-trust-corroborated/10 text-trust-corroborated"
        : "bg-trust-direct/10 text-trust-direct";
  const why =
    inference === "corroborated"
      ? "seen in more than one place"
      : inference === "inferred"
        ? "inferred from the content"
        : "seen directly";
  return (
    <span className={`chip ${color}`} title={`How sure we are: ${pct}% — ${why}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  OWNER_AUTHORIZED_API: "Their own account",
  OFFICIAL_PUBLIC_API: "Public listing",
  META_BUSINESS_DISCOVERY: "Facebook / Instagram",
  MANAGED_PUBLIC_PROVIDER_APIFY: "Social media",
  LICENSED_DATASET_BRIGHTDATA: "Licensed data",
  PUBLIC_WEBSITE_HTTP: "Their website",
  PUBLIC_WEBSITE_BROWSER: "Their website",
  USER_SUBMITTED: "You provided",
  MANUAL_ANALYST: "Reviewed by us",
  INFERRED_FROM_MULTIPLE_SOURCES: "Combined sources",
};

/** Human "where this came from" chip. */
export function ProvenanceBadge({ provenance }: { provenance: string }) {
  const label = SOURCE_LABEL[provenance] ?? "Public source";
  return (
    <span className="chip bg-surface-sunken text-ink-faint" title={`Source: ${provenance}`}>
      {label}
    </span>
  );
}
