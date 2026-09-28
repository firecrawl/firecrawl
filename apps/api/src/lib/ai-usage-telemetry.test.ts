import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { APICallError, generateObject, generateText, streamText } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { withUsageTelemetry } from "./ai-usage-telemetry";
import { createTracerProvider } from "./otel-tracer";

const telemetry = { isEnabled: true, functionId: "usage-telemetry-test" };

function mockUsage(details: {
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}) {
  return {
    inputTokens: {
      total: 1200,
      noCache:
        details.cacheRead === undefined ? undefined : 1200 - details.cacheRead,
      cacheRead: details.cacheRead,
      cacheWrite: details.cacheWrite,
    },
    outputTokens: {
      total: 50,
      text:
        details.reasoning === undefined ? undefined : 50 - details.reasoning,
      reasoning: details.reasoning,
    },
  };
}

function mockModel(usage: ReturnType<typeof mockUsage>) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"answer":"ok"}' }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

// Responses API body as returned by OpenAI for a request that hit the prompt
// cache and spent reasoning tokens.
const openAIResponsesBody = {
  id: "resp_test",
  object: "response",
  created_at: 1_700_000_000,
  model: "gpt-4o-mini",
  status: "completed",
  incomplete_details: null,
  service_tier: "default",
  output: [
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: '{"answer":"ok"}', annotations: [] },
      ],
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 20 },
    total_tokens: 1250,
  },
};

describe("usage telemetry middleware", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(() => {
    provider = createTracerProvider({
      exporter,
      serviceName: "test-service",
      serviceInstanceId: "pod-1",
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  beforeEach(() => {
    exporter.reset();
  });

  async function spanNamed(name: string): Promise<ReadableSpan> {
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans().filter(s => s.name === name);
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  it("records OpenAI Responses cached and reasoning tokens on the generateObject span from getModel", async () => {
    const savedEnv = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      MODEL_NAME: process.env.MODEL_NAME,
    };
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MODEL_NAME = "";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(openAIResponsesBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      vi.resetModules();
      const { getModel } = await import("./generic-ai.js");

      await generateObject({
        model: getModel("gpt-4o-mini", "openai"),
        schema: z.object({ answer: z.string() }),
        prompt: "hello",
        experimental_telemetry: telemetry,
      });
    } finally {
      vi.unstubAllGlobals();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Drop the generic-ai/config instances bound to the test env above.
      vi.resetModules();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toMatch(/\/responses$/);
    expect(init?.method).toBe("POST");
    const span = await spanNamed("ai.generateObject.doGenerate");
    expect(span.attributes).toMatchObject({
      "ai.usage.promptTokens": 1200,
      "ai.usage.completionTokens": 50,
      "ai.usage.cachedInputTokens": 1024,
      "ai.usage.reasoningTokens": 20,
      "ai.usage.inputTokenDetails.noCacheTokens": 176,
      "ai.usage.inputTokenDetails.cacheReadTokens": 1024,
      "ai.usage.outputTokenDetails.textTokens": 30,
      "ai.usage.outputTokenDetails.reasoningTokens": 20,
    });
  });

  it("records cache writes on the generateText span", async () => {
    await generateText({
      model: withUsageTelemetry(
        mockModel(mockUsage({ cacheRead: 0, cacheWrite: 900 })),
      ),
      prompt: "hello",
      experimental_telemetry: telemetry,
    });

    const span = await spanNamed("ai.generateText.doGenerate");
    expect(span.attributes).toMatchObject({
      "ai.usage.cachedInputTokens": 0,
      "ai.usage.inputTokenDetails.cacheReadTokens": 0,
      "ai.usage.inputTokenDetails.cacheWriteTokens": 900,
    });
  });

  it("records one span per attempt when the SDK retries", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        if (calls === 1) {
          throw new APICallError({
            message: "rate limited",
            url: "https://example.test",
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
          });
        }
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: mockUsage({ cacheRead: 512 }),
          warnings: [],
        };
      },
    });

    await generateText({
      model: withUsageTelemetry(model),
      prompt: "hello",
      maxRetries: 1,
      experimental_telemetry: telemetry,
    });

    await provider.forceFlush();
    const spans = exporter
      .getFinishedSpans()
      .filter(s => s.name === "ai.generateText.doGenerate");
    expect(spans).toHaveLength(2);
    expect(spans.map(s => s.attributes["ai.usage.cachedInputTokens"])).toEqual([
      undefined,
      512,
    ]);
  });

  it("omits usage details the provider does not report", async () => {
    await generateText({
      model: withUsageTelemetry(mockModel(mockUsage({}))),
      prompt: "hello",
      experimental_telemetry: telemetry,
    });

    const span = await spanNamed("ai.generateText.doGenerate");
    expect(span.attributes["ai.usage.promptTokens"]).toBe(1200);
    expect(
      Object.keys(span.attributes).filter(
        key =>
          key === "ai.usage.cachedInputTokens" ||
          key === "ai.usage.reasoningTokens" ||
          key.startsWith("ai.usage.inputTokenDetails.") ||
          key.startsWith("ai.usage.outputTokenDetails."),
      ),
    ).toEqual([]);
  });

  it("leaves the caller's span untouched when AI SDK telemetry is disabled", async () => {
    await trace.getTracer("test").startActiveSpan("caller", async span => {
      await generateText({
        model: withUsageTelemetry(mockModel(mockUsage({ cacheRead: 1024 }))),
        prompt: "hello",
      });
      span.end();
    });

    const span = await spanNamed("caller");
    expect(
      Object.keys(span.attributes).filter(key => key.startsWith("ai.")),
    ).toEqual([]);
  });

  it("streaming spans already carry cached input tokens", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "ok" },
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: mockUsage({ cacheRead: 1024, reasoning: 20 }),
          },
        ]),
      }),
    });

    const result = streamText({
      model: withUsageTelemetry(model),
      prompt: "hello",
      experimental_telemetry: telemetry,
    });
    await result.consumeStream();

    const span = await spanNamed("ai.streamText.doStream");
    expect(span.attributes).toMatchObject({
      "ai.usage.cachedInputTokens": 1024,
      "ai.usage.reasoningTokens": 20,
    });
  });
});
