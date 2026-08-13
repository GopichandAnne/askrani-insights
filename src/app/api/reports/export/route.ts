import { activeWorkspace } from "@/lib/workspace";
import { buildWorkspaceReport } from "@/lib/report";

export const dynamic = "force-dynamic";

/** RFC-4180-ish CSV cell escaping. */
function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

const TYPES = new Set(["pricing", "offers", "reputation", "events"]);

/** GET /api/reports/export?type=pricing|offers|reputation|events → CSV download. */
export async function GET(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") {
    return new Response("Not authorized or no workspace set up.", { status: 401 });
  }
  const type = (new URL(req.url).searchParams.get("type") ?? "pricing").toLowerCase();
  if (!TYPES.has(type)) return new Response("unknown export type", { status: 400 });

  const r = await buildWorkspaceReport(state.workspace);
  let rows: (string | number | null)[][];

  switch (type) {
    case "pricing":
      rows = [
        ["Business", "You", "Priced items", "Avg price", "Min price", "Max price"],
        ...r.pricing.map((p) => [p.name, p.isTarget ? "yes" : "", p.offers, p.avgPrice, p.minPrice, p.maxPrice]),
      ];
      break;
    case "offers":
      // one row per business summarising its offer set (offers detail lives on /offers)
      rows = [
        ["Business", "You", "Distinct priced items", "Avg price"],
        ...r.pricing.map((p) => [p.name, p.isTarget ? "yes" : "", p.offers, p.avgPrice]),
      ];
      break;
    case "reputation":
      rows = [
        ["Business", "You", "Rating", "Review count", "Reviews seen"],
        ...r.reputation.map((x) => [x.name, x.isTarget ? "yes" : "", x.rating, x.reviewCount, x.reviewsSeen]),
      ];
      break;
    case "events":
    default:
      rows = [
        ["Date", "Business", "Type", "Significance", "Summary"],
        ...r.events.map((e) => [e.at ?? "", e.business, e.type, e.significance, e.summary]),
      ];
      break;
  }

  const safeName = state.workspace.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filename = `askrani-${safeName}-${type}.csv`;
  const body = "﻿" + toCsv(rows); // BOM so Excel reads UTF-8

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
