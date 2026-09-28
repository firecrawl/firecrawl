import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildPromptWithWebsiteStructure: vi.fn(),
  getModel: vi.fn(),
}));

// Call through to the real AI SDK so its telemetry spans are produced, while
// still letting the tests read the options each call was made with.
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(actual.generateObject),
    generateText: vi.fn(actual.generateText),
  };
});

vi.mock("../../../lib/generic-ai", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/generic-ai")>()),
  getModel: mocks.getModel,
}));

vi.mock("../../../lib/map-utils", () => ({
  buildPromptWithWebsiteStructure: mocks.buildPromptWithWebsiteStructure,
}));

vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi
    .fn()
    .mockResolvedValue({ orgConfig: null, policy: null }),
}));

vi.mock("../../../lib/key-restriction", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/key-restriction")>()),
  checkKeyFormatRestriction: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/request-credits-store", () => ({
  initializeRequestCredits: vi.fn().mockResolvedValue(undefined),
  requestCreditsShards: vi.fn().mockReturnValue(1),
}));

vi.mock("../../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: vi.fn().mockResolvedValue(10),
}));

vi.mock("../../../lib/crawl-redis", () => ({
  crawlToCrawler: vi.fn(() => ({
    getRobotsTxt: vi.fn().mockResolvedValue(""),
  })),
  saveCrawl: vi.fn().mockResolvedValue(undefined),
  markCrawlActive: vi.fn().mockResolvedValue(undefined),
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
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { generateObject } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Mock } from "vitest";
import {
  createTracerProvider,
  withSpan,
  withZeroDataRetention,
} from "../../../lib/otel-tracer";
import { CostTracking } from "../../../lib/cost-tracking";
import { generateCompletions } from "../../../scraper/scrapeURL/transformers/llmExtract";
import { crawlController } from "../crawl";
import { crawlParamsPreviewController } from "../crawl-params-preview";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PROMPT = "only crawl the pricing pages of this site";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

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

function makeReq(
  body: Record<string, unknown>,
  flags: Record<string, unknown>,
) {
  return {
    body,
    auth: { team_id: TEAM_ID },
    acuc: { api_key_id: 7, org_id: null, flags },
    headers: {},
    protocol: "http",
    host: "localhost",
    get: () => undefined,
  } as any;
}

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function telemetryOfCalls() {
  return (generateObject as Mock).mock.calls.map(
    ([options]) => options.experimental_telemetry,
  );
}

describe("crawl prompt telemetry under zero data retention", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(() => {
    provider = createTracerProvider({ exporter, serviceName: "test-service" });
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
    (generateObject as Mock).mockClear();
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
    const res = makeRes();
    await crawlController(
      makeReq({ url: "https://example.com", prompt: PROMPT }, {}),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
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

  it.each([
    [
      "team-scoped",
      { url: "https://example.com", prompt: PROMPT },
      { scrapeZDR: "forced" },
    ],
    [
      "request-scoped",
      { url: "https://example.com", prompt: PROMPT, zeroDataRetention: true },
      { scrapeZDR: "allowed" },
    ],
  ])(
    "records nothing from the prompt step of a %s ZDR crawl",
    async (_scope, body, flags) => {
      const res = makeRes();
      await crawlController(makeReq(body, flags), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
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

  it.each([
    [
      "team-scoped",
      { url: "https://example.com", prompt: PROMPT },
      { scrapeZDR: "forced" },
    ],
    [
      "request-scoped",
      { url: "https://example.com", prompt: PROMPT, zeroDataRetention: true },
      {},
    ],
  ])(
    "records nothing from a %s ZDR params preview",
    async (_scope, body, flags) => {
      const res = makeRes();
      await crawlParamsPreviewController(makeReq(body, flags), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(telemetryOfCalls()).toEqual([
        expect.objectContaining({ isEnabled: false }),
      ]);
      expect(await exportedSpans()).toEqual([]);
    },
  );

  it("exports a params preview for a regular team", async () => {
    const res = makeRes();
    await crawlParamsPreviewController(
      makeReq({ url: "https://example.com", prompt: PROMPT }, {}),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
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
