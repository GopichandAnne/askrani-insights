import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { createWorkspaceFromCandidate, autoDiscoverCompetitors } from "@/lib/discovery";
import { inferVertical } from "@/lib/classify";
import { createServiceClient } from "@/lib/supabase/server";
import { quoteDeepRead, getBalance } from "@/lib/credits";
import { logEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const RETENTION_DAYS = 30;
const VALID = new Set(["grocery", "restaurant", "salon"]);

/**
 * Deep read — step 1 (QUOTE). Creates an EPHEMERAL workspace for the picked
 * business (goals.ephemeral = true, 30-day retention) and, for an area scan,
 * discovers the local competitor set. Discovery is cheap (Google/OSM) so this is
 * NOT charged — it just returns the exact credit quote + competitor count so the
 * owner can confirm before any paid scraping runs (step 2 = /run). Auth required:
 * deep read costs credits, unlike the public free Explore.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { candidate, vertical: rawVertical, scope: rawScope } = await req.json().catch(() => ({}));
  if (!candidate?.name) return badRequest("candidate.name required");
  const scope: "single" | "area" = rawScope === "area" ? "area" : "single";
  const vertical = VALID.has(rawVertical) ? rawVertical : inferVertical(candidate);

  try {
    const ws = await createWorkspaceFromCandidate(auth.orgId, candidate, vertical);
    const svc = createServiceClient();

    let competitorCount = 0;
    if (scope === "area") {
      const competitors = await autoDiscoverCompetitors(
        ws.workspaceId,
        { businessId: ws.businessId, name: candidate.name, geo: ws.geo, category: candidate.category, subtype: ws.subtype },
        { radiusKm: 6, limit: 12, vertical },
      );
      competitorCount = competitors.length;
    }

    const quote = quoteDeepRead(scope, competitorCount);
    const now = new Date();
    const expires = new Date(now.getTime() + RETENTION_DAYS * 86_400_000);
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.workspaceId).maybeSingle();
    await svc.from("workspace").update({
      goals: {
        ...((cur?.goals as object) ?? {}),
        ephemeral: true,
        ephemeralAt: now.toISOString(),
        ephemeralExpiresAt: expires.toISOString(),
        deepReadScope: scope,
        deepReadQuote: quote,
      },
    }).eq("id", ws.workspaceId);

    const balance = await getBalance(auth.orgId);
    void logEvent("deep_read_quote", { scope, competitorCount, quote }, { orgId: auth.orgId, path: "/explore" });
    return NextResponse.json({
      workspaceId: ws.workspaceId,
      scope,
      competitorCount,
      quote,
      balance,
      needsCredits: balance < quote,
      target: { name: candidate.name },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
