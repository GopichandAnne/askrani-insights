import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { requireOrg } from "@/lib/api";
import { createServiceClient } from "@/lib/supabase/server";
import { spendCredits, refundCredits, getBalance } from "@/lib/credits";
import { generateAiPage, slugify, pingIndexNow, AIPAGE_PUBLISH_CREDITS } from "@/lib/aipage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const APP_URL = () => (process.env.NEXT_PUBLIC_APP_URL || "https://insights.askrani.ai").replace(/\/$/, "");

/**
 * Publish (or refresh) the business's AI-ready page. Credit-gated: spends credits,
 * regenerates the page from current data, marks it published, and pings IndexNow.
 * Idempotent on the slug (stays stable across refreshes). Owner action only.
 */
export async function POST() {
  const state = await activeWorkspace();
  const auth = await requireOrg();
  if (state.status !== "ok" || !auth) return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  const ws = state.workspace;

  const ok = await spendCredits(auth.orgId, AIPAGE_PUBLISH_CREDITS, "aipage_publish", { workspaceId: ws.id });
  if (!ok) return NextResponse.json({ needsCredits: true, quote: AIPAGE_PUBLISH_CREDITS, balance: await getBalance(auth.orgId) });

  try {
    const page = await generateAiPage(ws);
    if (!page) { await refundCredits(auth.orgId, AIPAGE_PUBLISH_CREDITS, "aipage_refund", { workspaceId: ws.id }); return NextResponse.json({ error: "not_enough_data" }, { status: 400 }); }

    const svc = createServiceClient();
    const goals = (ws.goals as Record<string, any>) ?? {};

    // Stable slug: reuse the existing one; else derive from name (+ city if present)
    // and de-collide against other workspaces.
    let slug = goals.aiPageSlug as string | undefined;
    if (!slug) {
      const city = page.title.includes("—") ? page.title.split("—")[1] : "";
      const base = [slugify(ws.name), slugify(city)].filter(Boolean).join("-") || slugify(ws.name) || "business";
      slug = base;
      const { data: clash } = await svc.from("workspace").select("id").eq("goals->>aiPageSlug", slug).maybeSingle();
      if (clash && clash.id !== ws.id) slug = `${base}-${ws.id.slice(0, 4)}`;
    }

    const stored = { ...page, slug, published: true };
    await svc.from("workspace").update({ goals: { ...goals, aiPage: stored, aiPageSlug: slug } }).eq("id", ws.id);

    const url = `${APP_URL()}/m/${slug}`;
    await pingIndexNow(url);
    return NextResponse.json({ ok: true, url, updatedAt: stored.updatedAt });
  } catch (e) {
    await refundCredits(auth.orgId, AIPAGE_PUBLISH_CREDITS, "aipage_refund", { workspaceId: ws.id });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
