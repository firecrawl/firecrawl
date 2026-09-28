import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Meta } from "../..";
import { createTracerProvider } from "../../../../lib/otel-tracer";
import { scrapeURLWithXTwitter } from "./index";

const { grok } = vi.hoisted(() => {
  process.env.XAI_API_KEY = "test-key";
  return { grok: { doGenerate: undefined as any } };
});

vi.mock("@ai-sdk/xai", async importOriginal => {
  const actual = await importOriginal<typeof import("@ai-sdk/xai")>();
  return {
    xai: {
      responses: (modelId: string) =>
        new MockLanguageModelV3({
          provider: "xai.responses",
          modelId,
          doGenerate: (...args) => grok.doGenerate(...args),
        }),
      tools: actual.xai.tools,
    },
  };
});

const usage = {
  inputTokens: { total: 3000, noCache: 1000, cacheRead: 2000, cacheWrite: 0 },
  outputTokens: { total: 400, text: 400, reasoning: 0 },
};

function grokReturns(output: unknown) {
  grok.doGenerate = async () => ({
    content: [{ type: "text", text: JSON.stringify(output) }],
    finishReason: { unified: "stop", raw: "completed" },
    usage,
    warnings: [],
  });
}

function makeMeta(url: string, zeroDataRetention = false): Meta {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  return {
    id: "019990c0-0000-7000-8000-000000000001",
    url,
    logger,
    abort: { asSignal: () => undefined },
    internalOptions: { teamId: "team-test", zeroDataRetention },
  } as unknown as Meta;
}

describe("x-twitter engine LLM telemetry", () => {
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

  async function doGenerateSpan(): Promise<ReadableSpan> {
    await provider.forceFlush();
    const spans = exporter
      .getFinishedSpans()
      .filter(s => s.name === "ai.generateText.doGenerate");
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  it("records a usage span for a profile lookup", async () => {
    grokReturns({
      displayName: "Firecrawl",
      username: "firecrawl",
      bio: "Turn websites into LLM-ready data.",
      followers: 1000,
      latestPosts: [],
    });

    const result = await scrapeURLWithXTwitter(
      makeMeta("https://x.com/firecrawl"),
    );

    expect(result.markdown).toContain("@firecrawl");
    const span = await doGenerateSpan();
    expect(span.attributes).toMatchObject({
      "ai.telemetry.functionId": "xTwitter/profile",
      "ai.telemetry.metadata.feature": "x-twitter",
      "ai.telemetry.metadata.teamId": "team-test",
      "ai.telemetry.metadata.scrapeId": "019990c0-0000-7000-8000-000000000001",
      "ai.model.id": "grok-4-1-fast-non-reasoning",
      "ai.usage.promptTokens": 3000,
      "ai.usage.completionTokens": 400,
      "ai.usage.cachedInputTokens": 2000,
    });
    expect(span.attributes["ai.prompt.messages"]).toContain("@firecrawl");
  });

  it("records a usage span for a post lookup", async () => {
    grokReturns({
      authorUsername: "firecrawl",
      text: "Hello from a post.",
      likes: 10,
      retweets: 2,
    });

    await scrapeURLWithXTwitter(
      makeMeta("https://x.com/firecrawl/status/1234567890123"),
    );

    const span = await doGenerateSpan();
    expect(span.attributes).toMatchObject({
      "ai.telemetry.functionId": "xTwitter/post",
      "ai.telemetry.metadata.feature": "x-twitter",
      "ai.telemetry.metadata.teamId": "team-test",
      "ai.telemetry.metadata.scrapeId": "019990c0-0000-7000-8000-000000000001",
      "ai.model.id": "grok-4-1-fast-non-reasoning",
      "ai.usage.promptTokens": 3000,
      "ai.usage.completionTokens": 400,
      "ai.usage.cachedInputTokens": 2000,
    });
    expect(span.attributes["ai.prompt.messages"]).toContain(
      "post id 1234567890123",
    );
  });

  // Covers the per-call guard on its own; ZDR scrape jobs additionally run
  // under the tracer's ZDR context (see otel-tracer.test.ts).
  it("records no AI SDK spans for zero-data-retention scrapes", async () => {
    grokReturns({ username: "firecrawl", latestPosts: [] });

    await scrapeURLWithXTwitter(makeMeta("https://x.com/firecrawl", true));

    await provider.forceFlush();
    expect(
      exporter.getFinishedSpans().filter(s => s.name.startsWith("ai.")),
    ).toEqual([]);
  });

  it("records the span with an error status when the Grok call is rejected", async () => {
    grok.doGenerate = async () => {
      throw new APICallError({
        message: "bad request",
        url: "https://api.x.ai/v1/responses",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    };

    await expect(
      scrapeURLWithXTwitter(makeMeta("https://x.com/firecrawl")),
    ).rejects.toThrow("bad request");

    const span = await doGenerateSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["ai.telemetry.functionId"]).toBe("xTwitter/profile");
  });
});
