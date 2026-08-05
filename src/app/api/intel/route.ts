import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { getOrMakeEdge } from "@/lib/intel";

export const dynamic = "force-dynamic";
// The full edge synthesis (6 competitor moves + sentiment/trends/offerings/events)
// over a data-rich workspace (e.g. 8 restaurants with full delivery menus) can
// run 40–60s+ on the model. 60s was too tight — the function got killed mid-call,
// aborting the LLM request and falling back to the empty edge. 180s is safe.
export const maxDuration = 180;

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
