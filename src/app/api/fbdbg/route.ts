import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// TEMPORARY diagnostic — remove after use. Reveals why the Facebook Apify actor
// returns 0 posts (bad actor id vs wrong input shape vs empty result).
const TOKEN = "fbdbg-7q2x9k4m";

async function runActor(token: string, actor: string, input: unknown, budgetMs = 60000) {
  const run = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => r.json() as any).catch((e) => ({ err: String(e) }));
  const runId = run?.data?.id;
  if (!runId) return { started: false, runResponse: run };
  const deadline = Date.now() + budgetMs;
  let status = "", datasetId: string | undefined;
  while (Date.now() < deadline) {
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`).then((r) => r.json() as any);
    status = st?.data?.status;
    if (status === "SUCCEEDED") { datasetId = st?.data?.defaultDatasetId; break; }
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  let items: any[] = [];
  if (datasetId) items = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true&limit=2`).then((r) => r.json() as any).catch(() => []);
  return { started: true, status, count: Array.isArray(items) ? items.length : 0, sampleKeys: items[0] ? Object.keys(items[0]).slice(0, 25) : [], sample: items[0] ? JSON.stringify(items[0]).slice(0, 400) : null };
}

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("k") !== TOKEN) return new NextResponse("no", { status: 401 });
  const token = process.env.APIFY_TOKEN;
  const actor = process.env.APIFY_FACEBOOK_ACTOR;
  if (!token || !actor) return NextResponse.json({ hasToken: !!token, actor: actor ?? null, note: "missing token or actor env" });

  const page = "https://www.facebook.com/indiabazaar";
  const variants: Record<string, unknown> = {
    startUrls_resultsLimit: { startUrls: [{ url: page }], resultsLimit: 10 },
    startUrls_maxPosts: { startUrls: [{ url: page }], maxPosts: 10 },
    pageUrls: { pageUrls: [page], resultsLimit: 10 },
  };
  const out: any = { actor };
  for (const [name, input] of Object.entries(variants)) {
    try { out[name] = await runActor(token, actor, input); } catch (e) { out[name] = { err: (e as Error).message }; }
  }
  return NextResponse.json(out);
}
