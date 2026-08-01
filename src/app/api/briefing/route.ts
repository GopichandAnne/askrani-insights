import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { getOrMakeBriefing } from "@/lib/briefing";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Cached-or-generated weekly briefing for the caller's active workspace. */
export async function GET() {
  const state = await activeWorkspace();
  if (state.status !== "ok") {
    return NextResponse.json({ headline: "", summary: "" });
  }
  const briefing = await getOrMakeBriefing(state.workspace);
  return NextResponse.json(briefing);
}
