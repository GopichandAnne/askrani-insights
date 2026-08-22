import { activeWorkspace } from "@/lib/workspace";
import { buildWorkspaceReport } from "@/lib/report";
import { buildDigest } from "@/lib/digest";
import { renderReportXlsx } from "@/lib/reportxlsx";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * GET /api/reports/export?period=weekly|daily → a single organised Excel workbook
 * (Summary cover + Pricing + Reputation + Deals & offers + Market events). Replaces
 * the old per-type CSV dumps: one file, properly structured, you-highlighted, with
 * a plain-English summary up front.
 */
export async function GET(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") {
    return new Response("Not authorized or no workspace set up.", { status: 401 });
  }
  const period = new URL(req.url).searchParams.get("period") === "daily" ? "daily" : "weekly";

  const r = await buildWorkspaceReport(state.workspace);
  const goals = ((state.workspace as { goals?: Record<string, unknown> }).goals ?? {}) as Record<string, any>;
  const digest = buildDigest({ name: state.workspace.name, vertical: state.workspace.vertical }, goals);

  const buf = await renderReportXlsx({ name: state.workspace.name }, r, goals, digest, period);

  const safeName = state.workspace.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filename = `askrani-${safeName}-report.xlsx`;

  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
