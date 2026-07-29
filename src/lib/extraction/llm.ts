import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM abstraction — guide 3.1: "AI extraction/reasoning: OpenAI multimodal
 * models via structured JSON / Secondary model provider behind abstraction."
 * We keep the *contract* (structured JSON in, validated JSON out) provider-
 * agnostic. Claude is the default primary; OpenAI is a drop-in secondary.
 *
 * Guide 16.3 tiering: cheap model for classification, capable model for
 * high-value multimodal extraction. Both are configurable via env.
 */

export interface ImageInput {
  url?: string;
  base64?: string;
  mediaType?: string; // image/jpeg, image/png, application/pdf
}

export interface StructuredCall {
  system: string;
  text: string;
  images?: ImageInput[];
  /** JSON Schema the model must satisfy. */
  schema: Record<string, unknown>;
  tier?: "classify" | "extract";
  maxTokens?: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly modelFor: (tier: "classify" | "extract") => string;
  callStructured<T = unknown>(call: StructuredCall): Promise<{ data: T; modelVersion: string }>;
}

const MODELS = {
  anthropic: {
    classify: process.env.LLM_CLASSIFY_MODEL ?? "claude-haiku-4-5-20251001",
    extract: process.env.LLM_EXTRACT_MODEL ?? "claude-sonnet-5",
  },
  openai: {
    classify: process.env.OPENAI_CLASSIFY_MODEL ?? "gpt-4o-mini",
    extract: process.env.OPENAI_EXTRACT_MODEL ?? "gpt-4o",
  },
};

class AnthropicClient implements LlmClient {
  readonly provider = "anthropic";
  private client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  modelFor(tier: "classify" | "extract") {
    return MODELS.anthropic[tier];
  }

  async callStructured<T>(call: StructuredCall) {
    const model = this.modelFor(call.tier ?? "extract");
    const content: Anthropic.MessageParam["content"] = [{ type: "text", text: call.text }];
    for (const img of call.images ?? []) {
      if (img.url) {
        content.push({ type: "image", source: { type: "url", url: img.url } } as any);
      } else if (img.base64) {
        const isPdf = (img.mediaType ?? "").includes("pdf");
        content.push(
          isPdf
            ? ({
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: img.base64 },
              } as any)
            : ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: (img.mediaType as any) ?? "image/jpeg",
                  data: img.base64,
                },
              } as any),
        );
      }
    }

    const res = await this.client.messages.create({
      model,
      max_tokens: call.maxTokens ?? 2000,
      system: call.system,
      tools: [
        {
          name: "emit_result",
          description: "Return the extraction result as validated JSON.",
          input_schema: call.schema as any,
        },
      ],
      tool_choice: { type: "tool", name: "emit_result" },
      messages: [{ role: "user", content }],
    });

    const toolUse = res.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("model did not return a tool_use block");
    }
    return { data: toolUse.input as T, modelVersion: model };
  }
}

class OpenAiClient implements LlmClient {
  readonly provider = "openai";
  modelFor(tier: "classify" | "extract") {
    return MODELS.openai[tier];
  }
  async callStructured<T>(call: StructuredCall) {
    const model = this.modelFor(call.tier ?? "extract");
    const userContent: any[] = [{ type: "text", text: call.text }];
    for (const img of call.images ?? []) {
      if (img.url) userContent.push({ type: "image_url", image_url: { url: img.url } });
      else if (img.base64)
        userContent.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType ?? "image/jpeg"};base64,${img.base64}` },
        });
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: userContent },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "result", schema: call.schema, strict: false },
        },
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return { data: JSON.parse(data.choices[0].message.content) as T, modelVersion: model };
  }
}

let _llm: LlmClient | null = null;

export function getLlm(): LlmClient {
  if (_llm) return _llm;
  if (process.env.ANTHROPIC_API_KEY) _llm = new AnthropicClient();
  else if (process.env.OPENAI_API_KEY) _llm = new OpenAiClient();
  else throw new Error("No LLM configured: set ANTHROPIC_API_KEY or OPENAI_API_KEY");
  return _llm;
}

export function isLlmConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}
