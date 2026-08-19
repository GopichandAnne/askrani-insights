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
export interface ReportRow { primary: string; secondary?: string; tag?: string; tagTone?: "brand" | "alert" | "neutral" }
export interface ReportSection { title: string; note?: string; rows: ReportRow[] }
export interface ReportPdfInput {
  businessName: string;
  periodLabel: string;   // "Weekly market report" | "Daily market update"
  dateLabel: string;     // "August 12, 2026"
  headline: string;      // digest.headline
  stats: ReportStat[];
  groups: { key: DigestItem["severity"]; title: string; items: ReportGroupItem[] }[];
  sections: ReportSection[];   // the detailed report — sales, marketing, popular, what's changing
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
  // detailed report divider + sections
  divider: { flexDirection: "row", alignItems: "center", marginTop: 18, marginBottom: 4 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.line },
  dividerLabel: { fontSize: 8.5, fontFamily: "Helvetica-Bold", letterSpacing: 1.5, color: C.inkFaint, marginHorizontal: 8 },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", color: C.brandDeep },
  sectionAccent: { width: 26, height: 2, backgroundColor: C.brand, marginTop: 3, borderRadius: 1 },
  sectionNote: { fontSize: 8.5, color: C.inkFaint, marginTop: 5 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 6 },
  rowPrimary: { fontSize: 9.5, color: C.ink, lineHeight: 1.3 },
  rowSecondary: { fontSize: 8.5, color: C.inkFaint, marginTop: 2, lineHeight: 1.3 },
  rowTag: { fontSize: 8, fontFamily: "Helvetica-Bold", paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4, marginLeft: 8 },
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

function tagStyle(tone?: ReportRow["tagTone"]) {
  if (tone === "alert") return { backgroundColor: "#fdece2", color: C.coral };
  if (tone === "brand") return { backgroundColor: "#e6f7f3", color: C.brandDeep };
  return { backgroundColor: C.sunken, color: C.inkSoft };
}

function RowLine({ row }: { row: ReportRow }) {
  return (
    <View style={s.row} wrap={false}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={s.rowPrimary}>{row.primary}</Text>
        {row.secondary ? <Text style={s.rowSecondary}>{row.secondary}</Text> : null}
      </View>
      {row.tag ? <Text style={[s.rowTag, tagStyle(row.tagTone)]}>{row.tag}</Text> : null}
    </View>
  );
}

function SectionBlock({ section }: { section: ReportSection }) {
  return (
    <View style={s.section}>
      {/* glue title + first row so a section title never orphans at a page break */}
      <View wrap={false}>
        <Text style={s.sectionTitle}>{section.title}</Text>
        <View style={s.sectionAccent} />
        {section.note ? <Text style={s.sectionNote}>{section.note}</Text> : null}
        {section.rows[0] && <RowLine row={section.rows[0]} />}
      </View>
      {section.rows.slice(1).map((r, i) => <RowLine key={i} row={r} />)}
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

          {input.sections.length > 0 && (
            <>
              <View style={s.divider}>
                <View style={s.dividerLine} />
                <Text style={s.dividerLabel}>DETAILED REPORT</Text>
                <View style={s.dividerLine} />
              </View>
              {input.sections.map((sec, i) => <SectionBlock key={i} section={sec} />)}
            </>
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

  const sections = buildReportSections(goals);

  return { businessName: ws.name, periodLabel, dateLabel, headline: digest.headline, stats, groups, sections, empty: digest.items.length === 0 };
}

const clean = (v: unknown) => String(v ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const parseUsd = (v: unknown) => { const m = String(v ?? "").match(/\$?\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

/** The detailed report — richer, reference-style sections pulled purely from the
 *  cached pillars (sales, popularity, marketing, what's changing). No new cost. */
export function buildReportSections(goals: Record<string, any>): ReportSection[] {
  const sections: ReportSection[] = [];

  // 1) Sales & deals — the priced sale items + promos rivals are advertising
  const dealRows: ReportRow[] = [];
  const priced = ((goals.flyerDeals?.deals ?? []) as any[])
    .map((d) => ({ item: clean(d.item), price: clean(d.price), rival: clean(d.rival), n: parseUsd(d.price) }))
    .filter((d) => d.item);
  const seen = new Set<string>();
  for (const d of priced.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9))) {
    const k = `${d.rival}|${d.item}`.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    dealRows.push({ primary: d.item, secondary: d.rival || undefined, tag: d.price || undefined, tagTone: "alert" });
    if (dealRows.length >= 10) break;
  }
  for (const d of ((goals.deals?.deals ?? []) as any[]).slice(0, 8)) {
    const deal = clean(d.deal); if (!deal) continue;
    dealRows.push({ primary: deal, secondary: clean(d.rival) || undefined, tag: "promo", tagTone: "neutral" });
    if (dealRows.length >= 16) break;
  }
  if (dealRows.length) sections.push({ title: "Sales & deals in your market", note: "The prices and promos rivals are advertising right now — match or beat them.", rows: dealRows });

  // 2) Popular & winning nearby — what's trending + gaps to grab
  const popRows: ReportRow[] = [];
  for (const w of ((goals.winning?.winning ?? []) as any[])) {
    const name = clean(w?.name); if (!name) continue;
    popRows.push({ primary: name, secondary: clean(w?.signal) || undefined, tag: w?.onYourMenu === false ? "gap to grab" : "popular", tagTone: w?.onYourMenu === false ? "brand" : "neutral" });
    if (popRows.length >= 8) break;
  }
  for (const dm of ((goals.demand?.demands ?? []) as any[])) {
    if (!(dm?.heat === "high" && (dm?.servedLocally === "no" || dm?.servedLocally === "few"))) continue;
    const need = clean(dm?.need); if (!need) continue;
    popRows.push({ primary: need, secondary: clean(dm?.signal) || clean(dm?.move) || undefined, tag: "unmet demand", tagTone: "brand" });
    if (popRows.length >= 12) break;
  }
  if (popRows.length) sections.push({ title: "Popular & winning nearby", note: "What's trending in your market — and gaps worth grabbing before rivals do.", rows: popRows });

  // 3) Marketing & social moves — breakout posts, rising formats, competitor ads
  const mktRows: ReportRow[] = [];
  const sp = goals.socialPulse;
  if (sp && !sp.failed) {
    for (const b of ((sp.breakouts ?? []) as any[]).slice(0, 3)) {
      const rival = clean(b?.rival); if (!rival) continue;
      const cap = clean(b?.caption);
      mktRows.push({ primary: `${rival}'s post is taking off`, secondary: cap ? `“${cap.slice(0, 120)}”` : undefined, tag: b?.multiple ? `${b.multiple}× usual` : undefined, tagTone: "brand" });
    }
    for (const rf of ((sp.risingFormats ?? []) as string[]).slice(0, 2)) {
      const f = clean(rf); if (f) mktRows.push({ primary: `Rising format: ${f}`, secondary: clean(sp.summary) || undefined, tag: "trending", tagTone: "neutral" });
    }
  }
  const ads = goals.ads;
  if (ads && !ads.empty) {
    const adv = ((ads.advertisers ?? []) as any[]).map(clean).filter(Boolean).slice(0, 3);
    const move = clean(ads.moves?.[0]) || clean(ads.patterns?.[0]?.pattern);
    if (adv.length) mktRows.push({ primary: `Rivals running ads: ${adv.join(", ")}`, secondary: move || undefined, tag: "ads", tagTone: "alert" });
    else if (move) mktRows.push({ primary: "Rivals are advertising", secondary: move, tag: "ads", tagTone: "alert" });
  }
  if (mktRows.length) sections.push({ title: "Marketing & social moves", note: "How rivals are winning attention right now — worth a response.", rows: mktRows });

  // 4) What's changing — review themes moving + your rating momentum
  const chgRows: ReportRow[] = [];
  const pulse = goals.pulse;
  if (pulse && !pulse.failed) {
    for (const e of ((pulse.emerging ?? []) as any[]).slice(0, 3)) {
      const t = clean(e?.theme); if (t) chgRows.push({ primary: t, secondary: clean(pulse.summary) || undefined, tag: "growing complaint", tagTone: "alert" });
    }
    for (const r of ((pulse.rising ?? []) as string[]).slice(0, 3)) {
      const t = clean(r); if (t) chgRows.push({ primary: t, tag: "rising praise", tagTone: "brand" });
    }
  }
  const vel = goals.you?.reputation?.velocity;
  if (vel && typeof vel.ratingDelta === "number" && Math.abs(vel.ratingDelta) >= 0.1) {
    const down = vel.ratingDelta < 0;
    chgRows.push({ primary: `Your rating ${down ? "slipped" : "rose"} ${Math.abs(vel.ratingDelta).toFixed(1)}★`, secondary: vel.windowDays ? `over the last ${vel.windowDays} days` : undefined, tag: down ? "watch" : "good", tagTone: down ? "alert" : "brand" });
  }
  if (chgRows.length) sections.push({ title: "What's changing", note: "Shifts in what customers are saying — get ahead of them.", rows: chgRows });

  // 5) Findability — where you rank in Google search vs competitors
  const fbFull = goals.findability && !goals.findability.empty ? goals.findability : null;
  const fbBrief = goals.findabilityBrief && typeof goals.findabilityBrief.score === "number" ? goals.findabilityBrief : null;
  if (fbFull || fbBrief) {
    const fbRows: ReportRow[] = [];
    const score: number = fbFull?.score ?? fbBrief!.score;
    const cov = fbFull?.coverage ?? fbBrief?.coverage;
    const topRival = fbFull ? (fbFull.share ?? []).find((s: any) => !s.isYou)?.name : fbBrief?.topRival;
    fbRows.push({
      primary: `Findability score: ${score} / 100`,
      secondary: cov ? `top-3 for ${cov.inTop3} of ${cov.total} customer searches` : undefined,
      tag: score >= 60 ? "strong" : score >= 40 ? "watch" : "weak", tagTone: score >= 60 ? "brand" : score >= 40 ? "neutral" : "alert",
    });
    if (fbFull) {
      // the high-value terms you're buried on (or, failing that, your weakest terms)
      let terms = ((fbFull.keywords ?? []) as any[]).filter((k) => k.intent === "high_value" && (k.yourRank == null || k.yourRank > 3)).slice(0, 4);
      if (!terms.length) terms = [...((fbFull.keywords ?? []) as any[])].sort((a, b) => (b.yourRank ?? 99) - (a.yourRank ?? 99)).slice(0, 3);
      for (const k of terms) {
        fbRows.push({ primary: clean(k.term), secondary: k.topCompetitor ? `${clean(k.topCompetitor)} ranks above you` : undefined, tag: k.yourRank ? `#${k.yourRank}` : "not ranking", tagTone: "alert" });
      }
    } else if (fbBrief?.biggestSlip?.term) {
      const bs = fbBrief.biggestSlip;
      fbRows.push({ primary: clean(bs.term), secondary: topRival ? `${clean(topRival)} is ahead of you` : undefined, tag: bs.to ? `#${bs.to}` : "not ranking", tagTone: "alert" });
    }
    if (topRival) fbRows.push({ primary: `${clean(topRival)} leads local search`, secondary: "shows up in the top 3 for more of your customer searches", tag: "rival", tagTone: "neutral" });
    const rec = fbFull?.recommendation ?? fbBrief?.recommendation;
    if (rec) fbRows.push({ primary: clean(rec), tag: "do this", tagTone: "brand" });
    // Playbook — per-term plays to outrank the rival ahead (full report only)
    for (const p of (fbFull?.playbook ?? []).slice(0, 3) as any[]) {
      const levers = (p.levers ?? []).slice(0, 2).map((l: any) => `${clean(l.title)}: ${clean(l.detail)}`).join("  •  ");
      fbRows.push({
        primary: `Outrank ${p.rival ? clean(p.rival) : "the leader"} for "${clean(p.term)}"${p.yourRank ? ` (you #${p.yourRank})` : ""}`,
        secondary: levers || (p.gap ? clean(p.gap) : undefined),
        tag: "play", tagTone: "brand",
      });
    }
    if (fbRows.length) sections.push({ title: "Findability in Google search", note: "Where customers find you vs your competitors when they search — and what to fix first.", rows: fbRows });
  }

  return sections;
}
