import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { getOrMakeEdge } from "@/lib/intel";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Cached "Your Edge" brief for the active workspace. */
export async function GET() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const edge = await getOrMakeEdge(state.workspace);
  return NextResponse.json(edge);
}

/** Force a fresh synthesis (the "Refresh" button). */
export async function POST() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const edge = await getOrMakeEdge(state.workspace, { force: true });
  return NextResponse.json(edge);
}
