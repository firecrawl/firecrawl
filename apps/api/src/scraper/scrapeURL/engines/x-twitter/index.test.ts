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
import { CostTracking } from "../../../../lib/cost-tracking";
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

// Raw xAI Responses body; only the usage block is read from it.
function responseBody(xSearch?: { posts?: number; users?: number }) {
  return {
    object: "response",
    usage: {
      input_tokens: 3000,
      output_tokens: 400,
      ...(xSearch && {
        server_side_tool_usage_details: {
          x_search_calls: 2,
          x_posts_fetched: xSearch.posts,
          x_users_fetched: xSearch.users,
        },
      }),
    },
  };
}

function grokReturns(
  output: unknown,
  body: unknown = responseBody({ posts: 0, users: 0 }),
) {
  grok.doGenerate = async () => ({
    content: [{ type: "text", text: JSON.stringify(output) }],
    finishReason: { unified: "stop", raw: "completed" },
    usage,
    response: { body },
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
    costTracking: new CostTracking(),
  } as unknown as Meta;
}

// grok-4-1-fast-non-reasoning at $0.20 / $0.50 per 1M input / output tokens.
const tokenCost = (3000 * 0.2 + 400 * 0.5) / 1_000_000;

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

  beforeEach(async () => {
    // Drop spans a previous test left unflushed.
    await provider.forceFlush();
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
      "firecrawl.llm.tool.x_search_posts": 0,
      "firecrawl.llm.tool.x_search_profiles": 0,
    });
    expect(span.attributes["ai.prompt.messages"]).toContain("@firecrawl");
  });

  it("records X Search items on the span and their fee in cost tracking for a profile lookup", async () => {
    grokReturns(
      { username: "firecrawl", latestPosts: [] },
      responseBody({ posts: 44, users: 3 }),
    );
    const meta = makeMeta("https://x.com/firecrawl");

    await scrapeURLWithXTwitter(meta);

    const span = await doGenerateSpan();
    expect(span.attributes).toMatchObject({
      "firecrawl.llm.tool.x_search_posts": 44,
      "firecrawl.llm.tool.x_search_profiles": 3,
    });
    const { calls, totalCost } = meta.costTracking.toJSON();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: "other",
      model: "grok-4-1-fast-non-reasoning",
      tokens: { input: 3000, output: 400 },
      metadata: {
        module: "scrapeURL",
        method: "xTwitter/profile",
        xSearchPosts: 44,
        xSearchProfiles: 3,
      },
    });
    // 44 posts x $0.005 + 3 profiles x $0.01 = $0.25, plus tokens.
    expect(calls[0].cost).toBeCloseTo(0.25 + tokenCost, 10);
    expect(totalCost).toBeCloseTo(0.25 + tokenCost, 10);
  });

  it("records the X Search fee in cost tracking for a post lookup", async () => {
    grokReturns(
      { authorUsername: "firecrawl", text: "Hello from a post." },
      responseBody({ posts: 18, users: 0 }),
    );
    const meta = makeMeta("https://x.com/firecrawl/status/1234567890123");

    await scrapeURLWithXTwitter(meta);

    const { calls } = meta.costTracking.toJSON();
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata).toMatchObject({
      method: "xTwitter/post",
      xSearchPosts: 18,
      xSearchProfiles: 0,
    });
    expect(calls[0].cost).toBeCloseTo(18 * 0.005 + tokenCost, 10);
  });

  it("prices tokens only when xAI reports no X Search item counts", async () => {
    grokReturns({ username: "firecrawl", latestPosts: [] }, responseBody());
    const meta = makeMeta("https://x.com/firecrawl");

    await scrapeURLWithXTwitter(meta);

    const span = await doGenerateSpan();
    expect(
      Object.keys(span.attributes).filter(key =>
        key.startsWith("firecrawl.llm.tool."),
      ),
    ).toEqual([]);
    const { calls } = meta.costTracking.toJSON();
    expect(calls[0].metadata).toMatchObject({
      xSearchPosts: 0,
      xSearchProfiles: 0,
    });
    expect(calls[0].cost).toBeCloseTo(tokenCost, 10);
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

    const meta = makeMeta("https://x.com/firecrawl", true);
    await scrapeURLWithXTwitter(meta);

    await provider.forceFlush();
    expect(
      exporter.getFinishedSpans().filter(s => s.name.startsWith("ai.")),
    ).toEqual([]);
    // Billing-side cost is recorded regardless of telemetry.
    expect(meta.costTracking.toJSON().calls).toHaveLength(1);
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
    expect(
      Object.keys(span.attributes).filter(key =>
        key.startsWith("firecrawl.llm.tool."),
      ),
    ).toEqual([]);
    expect(span.attributes["ai.telemetry.functionId"]).toBe("xTwitter/profile");
  });
});
