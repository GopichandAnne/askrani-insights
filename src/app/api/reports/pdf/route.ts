import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { buildDigest } from "@/lib/digest";
import { buildReportInput, renderReportPdf } from "@/lib/reportpdf";

/**
 * GET /api/reports/pdf?period=weekly|daily → the owner-facing quick-glance PDF.
 * Built from the (deterministic, zero-cost) digest on the workspace's cached
 * goals — no scrape, no LLM. This is the artifact the cadence job will attach to
 * an email / WhatsApp later; for now it's a direct download.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return new Response("Not authorized or no workspace set up.", { status: 401 });
  const ws = state.workspace;

  const period = (new URL(req.url).searchParams.get("period") ?? "weekly").toLowerCase() === "daily" ? "daily" : "weekly";

  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};

  const digest = buildDigest({ name: ws.name, vertical: ws.vertical }, goals, (goals.digestSeen?.ids as string[]) ?? []);
  const input = buildReportInput({ name: ws.name }, goals, digest, period);
  const pdf = await renderReportPdf(input);

  const safe = ws.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="askrani-${safe}-${period}-report.pdf"`,
      "cache-control": "no-store",
    },
  });
}
