import express from "express";
import type { Response } from "express";
import request from "supertest";
import { vi } from "vitest";
import { createLogger } from "winston";
import type {
  generateObject as generateObjectFn,
  generateText as generateTextFn,
} from "ai";
import type { getModel as getModelFn } from "../../../lib/generic-ai";

const mocks = vi.hoisted(() => ({
  buildPromptWithWebsiteStructure: vi.fn(),
  getModel: vi.fn(),
}));

// Call through to the real AI SDK so its telemetry spans are produced, while
// still letting the tests read the options each call was made with.
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<{
    generateObject: typeof generateObjectFn;
    generateText: typeof generateTextFn;
  }>();
  return {
    ...actual,
    generateObject: vi.fn(actual.generateObject),
    generateText: vi.fn(actual.generateText),
  };
});

vi.mock("../../../lib/generic-ai", async importOriginal => ({
  ...(await importOriginal<{ getModel: typeof getModelFn }>()),
  getModel: mocks.getModel,
}));

vi.mock("../../../lib/map-utils", () => ({
  buildPromptWithWebsiteStructure: mocks.buildPromptWithWebsiteStructure,
}));

vi.mock("../../../lib/concurrency-limit", () => ({}));

vi.mock("../../../lib/crawl-redis", () => ({
  crawlToCrawler: vi.fn(() => ({
    getRobotsTxt: vi.fn().mockResolvedValue(""),
  })),
  saveCrawl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  crawlGroup: { addGroup: vi.fn().mockResolvedValue(undefined) },
  resolveNewGroupBackend: vi.fn().mockResolvedValue("nuq"),
}));

vi.mock("../../../services/queue-jobs", () => ({
  _addScrapeJobToBullMQ: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { generateObject } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { JsonObject } from "../../../lib/json-types";
import {
  createTracerProvider,
  withSpan,
  withZeroDataRetention,
} from "../../../lib/otel-tracer";
import { CostTracking } from "../../../lib/cost-tracking";
import { generateCompletions } from "../../../scraper/scrapeURL/transformers/llmExtract";
import type { RequestContext } from "../../../service/request-context";
import { createService, replaceService } from "../../../service/service";
import type { ResponsePayload } from "../../../service/hooks";
import { crawlController } from "../crawl";
import { crawlParamsPreviewController } from "../crawl-params-preview";
import type { AuthCreditUsageChunk, CrawlResponse, TeamFlags } from "../types";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PROMPT = "only crawl the pricing pages of this site";

const noopLogger = createLogger({ silent: true });

function mockModel() {
  return new MockLanguageModelV3({
    modelId: "gpt-4o-mini",
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"includePaths":["pricing/.*"]}' }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function makeAcuc(flags: TeamFlags): AuthCreditUsageChunk {
  return {
    api_key: "test-key",
    api_key_id: 7,
    team_id: TEAM_ID,
    org_id: "",
    flags,
    concurrency_limit: 10,
    rate_limit_multiplier: 1,
    is_paid_plan: false,
  };
}

async function postCrawl(
  body: JsonObject,
  flags: TeamFlags,
  ctx?: RequestContext,
): Promise<{
  status: number;
  body: CrawlResponse | ResponsePayload | undefined;
}> {
  let captured: CrawlResponse | ResponsePayload | undefined;
  const app = express();
  app.use(express.json());
  app.post(
    "/v2/crawl",
    async (req, res: Response<CrawlResponse | ResponsePayload>) => {
      const originalJson = res.json.bind(res);
      res.json = (payload: CrawlResponse | ResponsePayload) => {
        captured = payload;
        originalJson(payload);
        return res;
      };
      const authedReq = Object.assign(req, {
        auth: { team_id: TEAM_ID },
        acuc: makeAcuc(flags),
        ctx,
      });
      await crawlController(authedReq, res);
    },
  );
  const response = await request(app)
    .post("/v2/crawl")
    .set("Host", "localhost")
    .send(body);
  return { status: response.status, body: captured };
}

async function postCrawlParamsPreview(
  body: JsonObject,
  flags: TeamFlags,
  ctx?: RequestContext,
): Promise<{ status: number }> {
  const app = express();
  app.use(express.json());
  app.post("/v2/crawl/params-preview", async (req, res) => {
    const authedReq = Object.assign(req, {
      auth: { team_id: TEAM_ID },
      acuc: makeAcuc(flags),
      ctx,
    });
    await crawlParamsPreviewController(authedReq, res);
  });
  const response = await request(app)
    .post("/v2/crawl/params-preview")
    .set("Host", "localhost")
    .send(body);
  return { status: response.status };
}

function telemetryOfCalls() {
  return vi
    .mocked(generateObject)
    .mock.calls.map(([options]) => options.telemetry);
}

describe("crawl prompt telemetry under zero data retention", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(() => {
    replaceService(
      createService(
        { modules: {} },
        { core: { name: "core" }, logger: { error: vi.fn() } },
      ),
    );
    provider = createTracerProvider({ exporter, serviceName: "test-service" });
    provider.register();
  });

  afterAll(async () => {
    replaceService(undefined);
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  beforeEach(() => {
    exporter.reset();
    vi.mocked(generateObject).mockClear();
    mocks.getModel.mockImplementation(() => mockModel());
    // Stands in for the site map lookup, which starts spans of its own.
    mocks.buildPromptWithWebsiteStructure.mockImplementation(
      async ({ basePrompt }: { basePrompt: string }) =>
        withSpan("test.map_site", async () => ({
          prompt: `${basePrompt}\n\nhttps://example.com/pricing`,
          websiteUrls: ["https://example.com/pricing"],
        })),
    );
  });

  async function exportedSpans() {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  }

  it("exports the prompt step of a regular crawl", async () => {
    const res = await postCrawl(
      { url: "https://example.com", prompt: PROMPT },
      {},
    );

    expect(res.status).toBe(200);
    expect(telemetryOfCalls()).toEqual([
      expect.objectContaining({ isEnabled: true }),
    ]);
    const spans = await exportedSpans();
    const names = spans.map(span => span.name);
    expect(names).toContain("test.map_site");
    expect(names).toContain("ai.generateObject");
    expect(JSON.stringify(spans.map(span => span.attributes))).toContain(
      PROMPT,
    );
  });

  it.each<[string, JsonObject, TeamFlags, RequestContext | undefined]>([
    [
      "context-scoped",
      { url: "https://example.com", prompt: PROMPT },
      { scrapeZDR: "forced" },
      { teamId: TEAM_ID, zeroDataRetention: true },
    ],
    [
      "request-scoped",
      { url: "https://example.com", prompt: PROMPT, zeroDataRetention: true },
      { scrapeZDR: "allowed" },
      undefined,
    ],
  ])(
    "records nothing from the prompt step of a %s ZDR crawl",
    async (_scope, body, flags, ctx) => {
      const res = await postCrawl(body, flags, ctx);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          promptGeneratedOptions: { includePaths: ["pricing/.*"] },
        }),
      );
      expect(telemetryOfCalls()).toEqual([
        expect.objectContaining({ isEnabled: false }),
      ]);
      expect(await exportedSpans()).toEqual([]);
    },
  );

  it.each<[string, JsonObject, TeamFlags, RequestContext | undefined]>([
    [
      "context-scoped",
      { url: "https://example.com", prompt: PROMPT },
      { scrapeZDR: "forced" },
      { teamId: TEAM_ID, zeroDataRetention: true },
    ],
    [
      "request-scoped",
      { url: "https://example.com", prompt: PROMPT, zeroDataRetention: true },
      {},
      undefined,
    ],
  ])(
    "records nothing from a %s ZDR params preview",
    async (_scope, body, flags, ctx) => {
      const res = await postCrawlParamsPreview(body, flags, ctx);

      expect(res.status).toBe(200);
      expect(telemetryOfCalls()).toEqual([
        expect.objectContaining({ isEnabled: false }),
      ]);
      expect(await exportedSpans()).toEqual([]);
    },
  );

  it("exports a params preview for a regular team", async () => {
    const res = await postCrawlParamsPreview(
      { url: "https://example.com", prompt: PROMPT },
      {},
    );

    expect(res.status).toBe(200);
    const names = (await exportedSpans()).map(span => span.name);
    expect(names).toContain("ai.generateObject");
  });

  it("turns off AI SDK telemetry in a ZDR context without an explicit flag", async () => {
    await withZeroDataRetention(true, () =>
      generateCompletions({
        logger: noopLogger,
        options: { prompt: PROMPT },
        markdown: "",
        model: mockModel(),
        retryModel: mockModel(),
        costTrackingOptions: { costTracking: new CostTracking(), metadata: {} },
        metadata: { teamId: TEAM_ID },
      }),
    );

    expect(telemetryOfCalls()).toEqual([
      expect.objectContaining({ isEnabled: false }),
    ]);
    expect(await exportedSpans()).toEqual([]);
  });
});
