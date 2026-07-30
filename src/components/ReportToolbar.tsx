"use client";

/**
 * Report actions: print / save-as-PDF and CSV downloads. Client-only because it
 * calls window.print(); the CSV links are plain downloads from the export route.
 */
export function ReportToolbar() {
  const exports: { type: string; label: string }[] = [
    { type: "pricing", label: "Pricing CSV" },
    { type: "offers", label: "Offers CSV" },
    { type: "reputation", label: "Reputation CSV" },
    { type: "events", label: "Events CSV" },
    { type: "costs", label: "Costs CSV" },
  ];
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <button onClick={() => window.print()} className="btn btn-primary">
        Print / Save as PDF
      </button>
      {exports.map((e) => (
        <a
          key={e.type}
          href={`/api/reports/export?type=${e.type}`}
          className="btn btn-secondary"
        >
          {e.label}
        </a>
      ))}
    </div>
  );
}
