import React from "react";
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { Digest, DigestItem } from "@/lib/digest";

/**
 * The owner-facing PDF report — the intuitive "quick glance" artifact we generate
 * and (later) email / WhatsApp to owners on their subscription cadence. It renders
 * the DIGEST (the deterministic, zero-cost "what changed + what to do" list) into a
 * branded one-to-two page PDF, grouped by urgency, with a plain-English snapshot
 * band up top. Server-side only (returns a Buffer) so it can be attached to a
 * message with no browser — see renderReportPdf().
 *
 * Deliberately NO real $ figures — owners see credits/positioning, never our cost.
 */

// ── brand palette (matches the app's teal + coral) ──────────────────────────
const C = {
  brand: "#0d9488", brandLight: "#14b8a6", brandDeep: "#0f766e",
  coral: "#ea580c",
  ink: "#1f2937", inkSoft: "#4b5563", inkFaint: "#9ca3af",
  line: "#e5e7eb", sunken: "#f4f5f7", white: "#ffffff",
  alert: "#ea580c", opportunity: "#0d9488", fyi: "#64748b",
};
const SEV_COLOR: Record<DigestItem["severity"], string> = { alert: C.alert, opportunity: C.opportunity, fyi: C.fyi };

export interface ReportStat { label: string; value: string; tone?: "brand" | "alert" | "neutral" }
export interface ReportGroupItem { pillar: string; title: string; detail: string; act?: string }
export interface ReportPdfInput {
  businessName: string;
  periodLabel: string;   // "Weekly market report" | "Daily market update"
  dateLabel: string;     // "August 12, 2026"
  headline: string;      // digest.headline
  stats: ReportStat[];
  groups: { key: DigestItem["severity"]; title: string; items: ReportGroupItem[] }[];
  empty: boolean;
}

const s = StyleSheet.create({
  page: { paddingTop: 0, paddingBottom: 54, paddingHorizontal: 0, fontFamily: "Helvetica", color: C.ink, fontSize: 10 },
  // header band
  header: { backgroundColor: C.brandDeep, paddingHorizontal: 40, paddingTop: 30, paddingBottom: 22, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  brandKicker: { color: C.brandLight, fontSize: 9, fontFamily: "Helvetica-Bold", letterSpacing: 1.5, textTransform: "uppercase" },
  bizName: { color: C.white, fontSize: 22, fontFamily: "Helvetica-Bold", marginTop: 4 },
  headerRight: { alignItems: "flex-end" },
  periodLabel: { color: C.white, fontSize: 11, fontFamily: "Helvetica-Bold" },
  dateLabel: { color: "#cbeae6", fontSize: 9, marginTop: 3 },
  // body
  body: { paddingHorizontal: 40, paddingTop: 22 },
  headline: { fontSize: 16, fontFamily: "Helvetica-Bold", color: C.ink, marginBottom: 12 },
  // stat chips
  statRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 20 },
  chip: { flexDirection: "row", alignItems: "center", backgroundColor: C.sunken, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 9, marginRight: 8, marginBottom: 8 },
  chipDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  chipValue: { fontFamily: "Helvetica-Bold", fontSize: 10, color: C.ink },
  chipLabel: { fontSize: 9, color: C.inkSoft, marginLeft: 4 },
  // group
  groupHead: { flexDirection: "row", alignItems: "center", marginTop: 6, marginBottom: 8 },
  groupBar: { width: 4, height: 13, borderRadius: 2, marginRight: 7 },
  groupTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", color: C.ink },
  groupCount: { fontSize: 9, color: C.inkFaint, marginLeft: 6 },
  // item card
  card: { borderWidth: 1, borderColor: C.line, borderRadius: 8, borderLeftWidth: 3, padding: 11, marginBottom: 8 },
  pillar: { fontSize: 7.5, fontFamily: "Helvetica-Bold", letterSpacing: 0.8, textTransform: "uppercase", color: C.inkFaint, marginBottom: 3 },
  itemTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.ink, marginBottom: 3, lineHeight: 1.3 },
  itemDetail: { fontSize: 9.5, color: C.inkSoft, lineHeight: 1.4 },
  actRow: { flexDirection: "row", marginTop: 6, backgroundColor: "#ecfdf5", borderRadius: 5, paddingVertical: 5, paddingHorizontal: 7 },
  actLabel: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.brandDeep, marginRight: 5 },
  actText: { fontSize: 9, color: C.brandDeep, flex: 1, lineHeight: 1.35 },
  // empty
  emptyCard: { borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 22, alignItems: "center", marginTop: 8 },
  emptyTitle: { fontSize: 13, fontFamily: "Helvetica-Bold", color: C.brandDeep, marginBottom: 4 },
  emptyText: { fontSize: 10, color: C.inkSoft, textAlign: "center" },
  // footer
  footer: { position: "absolute", bottom: 22, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 },
  footerText: { fontSize: 8, color: C.inkFaint },
  footerBrand: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.brand },
});

function StatChip({ stat }: { stat: ReportStat }) {
  const dot = stat.tone === "alert" ? C.alert : stat.tone === "brand" ? C.brand : C.inkFaint;
  return (
    <View style={s.chip}>
      <View style={[s.chipDot, { backgroundColor: dot }]} />
      <Text style={s.chipValue}>{stat.value}</Text>
      <Text style={s.chipLabel}>{stat.label}</Text>
    </View>
  );
}

function ItemCard({ item, color }: { item: ReportGroupItem; color: string }) {
  return (
    <View style={[s.card, { borderLeftColor: color }]} wrap={false}>
      <Text style={s.pillar}>{item.pillar}</Text>
      <Text style={s.itemTitle}>{item.title}</Text>
      {item.detail ? <Text style={s.itemDetail}>{item.detail}</Text> : null}
      {item.act ? (
        <View style={s.actRow}>
          <Text style={s.actLabel}>DO THIS</Text>
          <Text style={s.actText}>{item.act}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ReportDoc({ input }: { input: ReportPdfInput }) {
  return (
    <Document title={`${input.businessName} — ${input.periodLabel}`} author="Ask Rani Insights">
      <Page size="A4" style={s.page}>
        <View style={s.header} fixed>
          <View>
            <Text style={s.brandKicker}>Ask Rani Insights</Text>
            <Text style={s.bizName}>{input.businessName}</Text>
          </View>
          <View style={s.headerRight}>
            <Text style={s.periodLabel}>{input.periodLabel}</Text>
            <Text style={s.dateLabel}>{input.dateLabel}</Text>
          </View>
        </View>

        <View style={s.body}>
          <Text style={s.headline}>{input.headline}</Text>

          {input.stats.length > 0 && (
            <View style={s.statRow}>
              {input.stats.map((st, i) => <StatChip key={i} stat={st} />)}
            </View>
          )}

          {input.empty ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>You&apos;re all caught up</Text>
              <Text style={s.emptyText}>No new competitor moves or alerts this period. We&apos;ll keep watching and flag anything the moment it changes.</Text>
            </View>
          ) : (
            input.groups.map((g) => (
              <View key={g.key} style={{ marginBottom: 6 }}>
                {/* keep the section header glued to its first card so it never orphans at a page break */}
                <View wrap={false}>
                  <View style={s.groupHead}>
                    <View style={[s.groupBar, { backgroundColor: SEV_COLOR[g.key] }]} />
                    <Text style={s.groupTitle}>{g.title}</Text>
                    <Text style={s.groupCount}>{g.items.length}</Text>
                  </View>
                  {g.items[0] && <ItemCard item={g.items[0]} color={SEV_COLOR[g.key]} />}
                </View>
                {g.items.slice(1).map((it, i) => <ItemCard key={i} item={it} color={SEV_COLOR[g.key]} />)}
              </View>
            ))
          )}
        </View>

        <View style={s.footer} fixed>
          <Text style={s.footerText}>Generated {input.dateLabel} · Open your dashboard for the full picture</Text>
          <Text style={s.footerBrand} render={({ pageNumber, totalPages }) => `Ask Rani Insights · ${pageNumber}/${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Render the report PDF to a Buffer (server-side, no browser). */
export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  return renderToBuffer(<ReportDoc input={input} />);
}

// ── shaping: Digest (+ goals snapshot) → presentational ReportPdfInput ───────
const GROUP_TITLE: Record<DigestItem["severity"], string> = {
  alert: "Needs your attention",
  opportunity: "Opportunities to grab",
  fyi: "Good to know",
};
const GROUP_ORDER: DigestItem["severity"][] = ["alert", "opportunity", "fyi"];

export function buildReportInput(
  ws: { name: string },
  goals: Record<string, any>,
  digest: Digest,
  period: "weekly" | "daily",
  now = new Date(),
): ReportPdfInput {
  const dateLabel = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const periodLabel = period === "daily" ? "Daily market update" : "Weekly market report";

  // snapshot band — plain-English position, no $ figures
  const stats: ReportStat[] = [];
  if (digest.alertCount > 0) stats.push({ value: String(digest.alertCount), label: digest.alertCount === 1 ? "needs attention" : "need attention", tone: "alert" });
  if (digest.opportunityCount > 0) stats.push({ value: String(digest.opportunityCount), label: digest.opportunityCount === 1 ? "opportunity" : "opportunities", tone: "brand" });
  if (digest.newCount > 0) stats.push({ value: String(digest.newCount), label: `new ${period === "daily" ? "today" : "this week"}`, tone: "neutral" });

  const rep = goals.you?.reputation;
  if (rep && typeof rep.rating === "number") {
    const mkt = typeof rep.marketAvg === "number" ? ` vs ${rep.marketAvg}★ market` : "";
    stats.push({ value: `${rep.rating}★`, label: `your rating${mkt}`, tone: rep.marketAvg != null && rep.rating >= rep.marketAvg ? "brand" : rep.marketAvg != null ? "alert" : "neutral" });
  }
  const rivals = new Set<string>();
  for (const d of [...((goals.deals?.deals ?? []) as any[]), ...((goals.flyerDeals?.deals ?? []) as any[])]) {
    const r = String(d?.rival ?? "").trim(); if (r) rivals.add(r.toLowerCase());
  }
  if (rivals.size > 0) stats.push({ value: String(rivals.size), label: rivals.size === 1 ? "rival with live deals" : "rivals with live deals", tone: "neutral" });

  // group items by severity, preserving the digest's internal ranking
  const groups = GROUP_ORDER
    .map((key) => ({
      key,
      title: GROUP_TITLE[key],
      items: digest.items.filter((i) => i.severity === key).map((i) => ({ pillar: i.pillar, title: i.title, detail: i.detail, act: i.act?.move })),
    }))
    .filter((g) => g.items.length > 0);

  return { businessName: ws.name, periodLabel, dateLabel, headline: digest.headline, stats, groups, empty: digest.items.length === 0 };
}
