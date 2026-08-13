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
  ];
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <a href="/api/reports/pdf?period=weekly" className="btn btn-primary">
        📄 Download PDF report
      </a>
      <button onClick={() => window.print()} className="btn btn-secondary">
        Print this page
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
