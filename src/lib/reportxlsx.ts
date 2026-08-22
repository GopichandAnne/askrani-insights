import ExcelJS from "exceljs";
import type { WorkspaceReport } from "@/lib/report";
import type { Digest } from "@/lib/digest";

/**
 * The owner-facing Excel workbook — NOT a raw dump. One organised workbook with a
 * plain-English **Summary** cover (where you stand + this week + top actions), then
 * a focused, styled sheet per topic (Pricing, Reputation, Deals & offers, Market
 * events). Every sheet has a title, a one-line "what this is", a bold frozen header,
 * sensible sorting, your row highlighted, and real number formats — so it reads,
 * not just holds data. Server-side (returns a Buffer); no browser needed.
 */

// brand palette (ARGB for exceljs fills)
const HEX = { brandDeep: "FF0F766E", brand: "FF0D9488", brandSoft: "FFE6F7F3", coral: "FFEA580C", coralSoft: "FFFDECE2", ink: "FF1F2937", inkFaint: "FF9CA3AF", sunken: "FFF4F5F7", white: "FFFFFFFF", line: "FFE5E7EB", youFill: "FFEFFAF7" };

type Tone = "brand" | "alert" | "neutral";

function titleBlock(ws: ExcelJS.Worksheet, title: string, note: string, span = 6) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { bold: true, size: 15, color: { argb: HEX.brandDeep } };
  ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, span);
  const n = ws.getCell(2, 1);
  n.value = note;
  n.font = { size: 9, italic: true, color: { argb: HEX.inkFaint } };
  ws.getRow(3).height = 4; // spacer
}

/** Style the header row of a data table that starts at `headerRow`. */
function styleHeader(ws: ExcelJS.Worksheet, headerRow: number, cols: number) {
  const row = ws.getRow(headerRow);
  row.font = { bold: true, size: 10, color: { argb: HEX.white } };
  row.height = 18;
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEX.brandDeep } };
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: HEX.line } } };
  }
  ws.views = [{ state: "frozen", ySplit: headerRow }];
}

function highlightYou(row: ExcelJS.Row, cols: number) {
  row.font = { bold: true };
  for (let c = 1; c <= cols; c++) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEX.youFill } };
  }
}

const usdFmt = '"$"#,##0.00;[Red]"$"#,##0.00';

// ── Summary (cover) ──────────────────────────────────────────────────────────
function addSummary(wb: ExcelJS.Workbook, ws: { name: string }, r: WorkspaceReport, goals: Record<string, any>, digest: Digest, periodLabel: string, dateLabel: string) {
  const sh = wb.addWorksheet("Summary", { properties: { tabColor: { argb: HEX.brandDeep } } });
  sh.getColumn(1).width = 30;
  sh.getColumn(2).width = 52;
  sh.getColumn(3).width = 20;

  let row = 1;
  const heading = (text: string) => {
    row++; // spacer
    const c = sh.getCell(row, 1);
    c.value = text.toUpperCase();
    c.font = { bold: true, size: 10, color: { argb: HEX.brandDeep } };
    sh.getCell(row, 1).border = { bottom: { style: "thin", color: { argb: HEX.line } } };
    sh.mergeCells(row, 1, row, 3);
    row++;
  };
  const kv = (k: string, v: string | number, tone?: Tone) => {
    sh.getCell(row, 1).value = k;
    sh.getCell(row, 1).font = { color: { argb: HEX.inkFaint }, size: 10 };
    const vc = sh.getCell(row, 2);
    vc.value = v;
    vc.font = { bold: true, size: 11, color: { argb: tone === "alert" ? HEX.coral : tone === "brand" ? HEX.brandDeep : HEX.ink } };
    row++;
  };

  // title
  sh.mergeCells(row, 1, row, 3);
  sh.getCell(row, 1).value = "Ask Rani Insights — Market Report";
  sh.getCell(row, 1).font = { bold: true, size: 16, color: { argb: HEX.brandDeep } };
  sh.getRow(row).height = 24; row++;
  sh.mergeCells(row, 1, row, 3);
  sh.getCell(row, 1).value = `${ws.name} · ${periodLabel} · ${dateLabel}`;
  sh.getCell(row, 1).font = { size: 10, color: { argb: HEX.inkFaint } };
  row++;
  sh.mergeCells(row, 1, row, 3);
  sh.getCell(row, 1).value = digest.headline;
  sh.getCell(row, 1).font = { bold: true, size: 12, color: { argb: HEX.ink } };
  row++;

  // where you stand
  const rep = goals.you?.reputation;
  const fbScore: number | null = goals.findability && !goals.findability.empty && typeof goals.findability.score === "number" ? goals.findability.score
    : goals.findabilityBrief && typeof goals.findabilityBrief.score === "number" ? goals.findabilityBrief.score : null;
  if ((rep && typeof rep.rating === "number") || fbScore != null) {
    heading("Where you stand");
    if (rep && typeof rep.rating === "number") {
      const beats = typeof rep.marketAvg === "number" ? rep.rating >= rep.marketAvg : null;
      kv("Your rating", `${rep.rating}★${typeof rep.marketAvg === "number" ? `  (market avg ${rep.marketAvg}★)` : ""}`, beats == null ? "neutral" : beats ? "brand" : "alert");
      if (typeof rep.rank === "number" && typeof rep.total === "number") kv("Rank by rating", `#${rep.rank} of ${rep.total}`, rep.rank <= Math.ceil(rep.total / 2) ? "brand" : "alert");
    }
    if (fbScore != null) kv("Findability in Google", `${fbScore} / 100`, fbScore >= 60 ? "brand" : fbScore >= 40 ? "neutral" : "alert");
  }

  // this week
  heading("This week");
  kv("Needs your attention", digest.alertCount, digest.alertCount > 0 ? "alert" : "neutral");
  kv("Opportunities to grab", digest.opportunityCount, digest.opportunityCount > 0 ? "brand" : "neutral");
  kv("New this period", digest.newCount, "neutral");

  // top actions
  const actions = digest.items.filter((i) => i.act?.move).slice(0, 6);
  if (actions.length) {
    heading("Top actions");
    for (const it of actions) {
      sh.getCell(row, 1).value = it.pillar;
      sh.getCell(row, 1).font = { size: 9, bold: true, color: { argb: HEX.inkFaint } };
      sh.mergeCells(row, 2, row, 3);
      const c = sh.getCell(row, 2);
      c.value = `${it.title} → ${it.act!.move}`;
      c.font = { size: 10, color: { argb: HEX.ink } };
      c.alignment = { wrapText: true, vertical: "top" };
      sh.getRow(row).height = 26;
      row++;
    }
  }

  // what's in the workbook
  heading("In this workbook");
  const guide = [
    ["Pricing", "Priced items per business — you vs competitors."],
    ["Reputation", "Ratings & review counts by source, ranked."],
    ["Deals & offers", "The sale prices & promos rivals are advertising."],
    ["Market events", "What moved in your market, most significant first."],
  ];
  for (const [k, v] of guide) {
    sh.getCell(row, 1).value = k;
    sh.getCell(row, 1).font = { bold: true, size: 10, color: { argb: HEX.brandDeep } };
    sh.mergeCells(row, 2, row, 3);
    sh.getCell(row, 2).value = v;
    sh.getCell(row, 2).font = { size: 10, color: { argb: HEX.inkFaint } };
    row++;
  }
}

// ── Pricing ──────────────────────────────────────────────────────────────────
function addPricing(wb: ExcelJS.Workbook, r: WorkspaceReport) {
  const sh = wb.addWorksheet("Pricing");
  titleBlock(sh, "Pricing comparison", "Distinct priced items per business — you vs. competitors. Sorted with you first, then by average price.");
  const H = 4;
  sh.getRow(H).values = ["Business", "You", "Priced items", "Avg price", "Min price", "Max price"];
  sh.columns = [{ width: 34 }, { width: 6 }, { width: 13 }, { width: 12 }, { width: 12 }, { width: 12 }];
  styleHeader(sh, H, 6);
  const rows = [...r.pricing].sort((a, b) => (a.isTarget === b.isTarget ? (b.avgPrice ?? 0) - (a.avgPrice ?? 0) : a.isTarget ? -1 : 1));
  for (const p of rows) {
    const row = sh.addRow([p.name, p.isTarget ? "You" : "", p.offers, p.avgPrice, p.minPrice, p.maxPrice]);
    for (const c of [4, 5, 6]) row.getCell(c).numFmt = usdFmt;
    if (p.isTarget) highlightYou(row, 6);
  }
  if (rows.length === 0) sh.addRow(["No priced items collected yet."]);
}

// ── Reputation ───────────────────────────────────────────────────────────────
const SRC: Record<string, string> = { google: "Google", yelp: "Yelp", facebook: "Facebook", tripadvisor: "TripAdvisor", trustpilot: "Trustpilot" };
function addReputation(wb: ExcelJS.Workbook, r: WorkspaceReport) {
  const sh = wb.addWorksheet("Reputation");
  titleBlock(sh, "Reputation", "Ratings and review counts we've observed, best-rated first. 'By source' shows each platform's rating.");
  const H = 4;
  sh.getRow(H).values = ["Business", "You", "Rating", "Reviews", "By source"];
  sh.columns = [{ width: 34 }, { width: 6 }, { width: 9 }, { width: 10 }, { width: 44 }];
  styleHeader(sh, H, 5);
  const rows = [...r.reputation].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  for (const x of rows) {
    const bySrc = x.sources.map((s) => `${SRC[s.source] ?? s.source} ${s.rating}★${s.reviewCount != null ? ` (${s.reviewCount})` : ""}`).join("  ·  ");
    const row = sh.addRow([x.name, x.isTarget ? "You" : "", x.rating ?? "—", x.reviewCount ?? "—", bySrc || "—"]);
    row.getCell(3).numFmt = "0.0";
    if (x.isTarget) highlightYou(row, 5);
  }
  if (rows.length === 0) sh.addRow(["No reviews collected yet."]);
}

// ── Deals & offers ───────────────────────────────────────────────────────────
const clean = (v: unknown) => String(v ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const parseUsd = (v: unknown) => { const m = String(v ?? "").match(/\$?\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
function addDeals(wb: ExcelJS.Workbook, goals: Record<string, any>) {
  const sh = wb.addWorksheet("Deals & offers");
  titleBlock(sh, "Deals & offers in your market", "Sale prices read from rivals' flyers, plus promos they're posting — cheapest first. Match or beat them.", 4);
  const H = 4;
  sh.getRow(H).values = ["Item / promo", "Price", "Rival", "Kind"];
  sh.columns = [{ width: 44 }, { width: 12 }, { width: 30 }, { width: 12 }];
  styleHeader(sh, H, 4);
  const flyer = ((goals.flyerDeals?.deals ?? []) as any[])
    .map((d) => ({ item: clean(d.item), price: clean(d.price), rival: clean(d.rival), n: parseUsd(d.price) }))
    .filter((d) => d.item)
    .sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9));
  const seen = new Set<string>();
  let n = 0;
  for (const d of flyer) {
    const k = `${d.rival}|${d.item}`.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    const row = sh.addRow([d.item, d.price || "—", d.rival || "—", "sale price"]);
    if (d.n != null) { row.getCell(2).value = d.n; row.getCell(2).numFmt = usdFmt; }
    n++;
  }
  for (const d of (goals.deals?.deals ?? []) as any[]) {
    const deal = clean(d.deal); if (!deal) continue;
    sh.addRow([deal, "—", clean(d.rival) || "—", "promo"]);
    n++;
  }
  if (n === 0) sh.addRow(["No rival deals captured yet."]);
}

// ── Market events ────────────────────────────────────────────────────────────
function addEvents(wb: ExcelJS.Workbook, r: WorkspaceReport) {
  const sh = wb.addWorksheet("Market events");
  titleBlock(sh, "Recent market events", "What moved across your market, most significant first.", 5);
  const H = 4;
  sh.getRow(H).values = ["Date", "Business", "Type", "Significance", "Summary"];
  sh.columns = [{ width: 13 }, { width: 30 }, { width: 16 }, { width: 12 }, { width: 60 }];
  styleHeader(sh, H, 5);
  const rows = [...r.events].sort((a, b) => (b.significance - a.significance) || String(b.at ?? "").localeCompare(String(a.at ?? "")));
  for (const e of rows) {
    const date = e.at ? new Date(e.at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
    const row = sh.addRow([date, e.business, e.type.replace(/_/g, " "), e.significance, e.summary]);
    row.getCell(5).alignment = { wrapText: true };
  }
  if (rows.length === 0) sh.addRow(["No events in this window."]);
}

export async function renderReportXlsx(
  ws: { name: string },
  r: WorkspaceReport,
  goals: Record<string, any>,
  digest: Digest,
  period: "weekly" | "daily",
  now = new Date(),
): Promise<Buffer> {
  const dateLabel = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const periodLabel = period === "daily" ? "Daily market update" : "Weekly market report";
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ask Rani Insights";
  wb.created = now;
  addSummary(wb, ws, r, goals, digest, periodLabel, dateLabel);
  addPricing(wb, r);
  addReputation(wb, r);
  addDeals(wb, goals);
  addEvents(wb, r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
