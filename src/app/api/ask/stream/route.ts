import { streamAnswer } from "@/lib/ask";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** POST { question } → streamed plain-text answer (token-by-token), grounded in
 *  the caller's workspace data. Read the body with a stream reader on the client. */
export async function POST(req: Request) {
  const { question } = await req.json().catch(() => ({}));
  if (!question || typeof question !== "string" || question.trim().length < 2) {
    return new Response("Type a question.", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamAnswer(question.trim())) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch {
        controller.enqueue(encoder.encode("\n\n(Sorry — the answer was interrupted.)"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
