import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ask";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** POST { question } → { answerable, answer } grounded in the caller's workspace data. */
export async function POST(req: Request) {
  const { question } = await req.json().catch(() => ({}));
  if (!question || typeof question !== "string" || question.trim().length < 2) {
    return NextResponse.json({ answerable: false, answer: "Type a question." }, { status: 400 });
  }
  const result = await answerQuestion(question.trim());
  return NextResponse.json(result);
}
