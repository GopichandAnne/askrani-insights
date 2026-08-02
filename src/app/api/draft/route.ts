import { NextResponse } from "next/server";
import { activeWorkspace } from "@/lib/workspace";
import { generateDraft } from "@/lib/draft";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Generate ready-to-post copy for a recommended move (Act-on-it). */
export async function POST(req: Request) {
  const { move, context } = await req.json().catch(() => ({}));
  if (!move || typeof move !== "string") return NextResponse.json({ error: "move required" }, { status: 400 });
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const draft = await generateDraft({
    business: state.workspace.name,
    vertical: state.workspace.vertical,
    move,
    context: typeof context === "string" ? context : undefined,
  });
  if ("error" in draft) return NextResponse.json({ error: draft.error }, { status: 500 });
  return NextResponse.json(draft);
}
