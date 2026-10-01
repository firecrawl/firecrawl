/**
 * Streaming coverage for OpenAI-provider models.
 *
 * Structured streaming is not reachable from Firecrawl today: `streamText`
 * and `streamObject` are only re-exported by the LangSmith shim and never
 * called, and no `getModel()` caller uses a streaming API. These tests pin
 * that ordinary streaming still resolves the API surface normally and never
 * triggers structured capability resolution, so adding a structured streaming
 * call site cannot silently inherit tool-transport behaviour that has no
 * streaming implementation.
 */
import { generateObject, jsonSchema } from "ai";
const mutableConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: "k" as string | undefined,
  OPENAI_BASE_URL: undefined as string | undefined,
  MODEL_NAME: undefined as string | undefined,
  OPENAI_API_MODE: undefined as "auto" | "chat" | "responses" | undefined,
  OPENAI_STRUCTURED_OUTPUT_MODE: undefined as
    | "auto"
    | "strict"
    | "tool"
    | undefined,
  OLLAMA_BASE_URL: undefined as string | undefined,
  OPENROUTER_API_KEY: undefined as string | undefined,
  VERTEX_CREDENTIALS: undefined as string | undefined,
  MODEL_EMBEDDING_NAME: undefined as string | undefined,
}));
vi.mock("../../config", () => ({ config: mutableConfig }));

describe("openai streaming", () => {
  it("doStream resolves the API surface and performs zero structured probes", async () => {
    mutableConfig.OPENAI_BASE_URL = "http://s.invalid/v1";
    mutableConfig.MODEL_NAME = "m";
    mutableConfig.OPENAI_API_MODE = "chat";
    mutableConfig.OPENAI_STRUCTURED_OUTPUT_MODE = "auto";
    const calls: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u: any, i: any) => {
      const b = i?.body ? JSON.parse(i.body) : {};
      calls.push({ url: String(u), body: b });
      const chunks = [
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(chunks, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { getModel } = await import("../../lib/generic-ai.js");
    const model = getModel("gpt-4o-mini", "openai");
    const stream = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as any);
    let text = "";
    const seen: string[] = [];
    for await (const part of (stream as any).stream as AsyncIterable<any>) {
      seen.push(part.type);
      if (part.type === "text-delta") text += part.delta ?? "";
    }
    expect(text).toBe("hi");
    expect(seen).toContain("text-delta");
    expect(
      calls.filter(
        c => c.body.response_format || c.body.text?.format || c.body.tools,
      ),
    ).toHaveLength(0);
  }, 60000);

  it("fails closed if a schema-bearing request ever reaches the stream path", async () => {
    // Guard for a future structured-streaming call site: it must not silently
    // bypass the forced-tool transport, which has no streaming implementation.
    const { getModel } = await import("../../lib/generic-ai.js");
    const model = getModel("gpt-4o-mini", "openai");
    await expect(
      model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        responseFormat: {
          type: "json",
          name: "response",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      } as any),
    ).rejects.toMatchObject({ name: "OpenAiToolTransportViolationError" });
  }, 60000);
});
