vi.mock("../config", () => ({
  config: {
    GCS_INDEX_BUCKET_NAME: "index-bucket",
    HIGHLIGHT_MODEL_URL: "https://highlight.test",
    HIGHLIGHT_MODEL_TOKEN: "secret-token",
  },
}));

vi.mock("../services", () => ({
  useIndex: true,
  normalizeURLForIndex: vi.fn((url: string) => url),
  hashURL: vi.fn((url: string) => url),
  getIndexFromGCS: vi.fn(async (key: string) => ({
    html: `<main>${key}</main>`,
  })),
}));

vi.mock("../db/rpc", () => ({
  indexGetRecent5: vi.fn(async ({ url_hash }: { url_hash: string }) => [
    {
      id: `index:${url_hash}`,
      status: 200,
      created_at: new Date("2026-07-11T00:00:00Z"),
    },
  ]),
}));

vi.mock("../lib/html-to-markdown", () => ({
  parseMarkdown: vi.fn(async (html: string) => `markdown:${html}`),
}));

vi.mock("../scraper/scrapeURL/lib/removeUnwantedElements", () => ({
  htmlTransform: vi.fn(async (html: string) => html),
}));

vi.mock("./highlight-model", () => ({
  generateHighlightsBatch: vi.fn(),
  generateHighlightsIndexedBatch: vi.fn(),
}));

import {
  generateHighlightsBatch,
  generateHighlightsIndexedBatch,
} from "./highlight-model";
import { config } from "../config";
import { indexGetRecent5 } from "../db/rpc";
import {
  applyIndexedSearchHighlights,
  applySearchHighlights,
  highlightsEnvReady,
  runIndexedSearchHighlightsShadow,
  searchHighlightURLs,
} from "./highlights";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(function () {
    return this;
  }),
} as any;

afterEach(() => {
  vi.clearAllMocks();
});

describe("runIndexedSearchHighlightsShadow", () => {
  it("resolves lightweight index references without loading page content", async () => {
    vi.mocked(generateHighlightsIndexedBatch).mockResolvedValue(
      new Map([["0", { highlights: [], markdown: "shadow highlight" }]]),
    );
    const response = {
      web: [{ url: "https://first.test", description: "fallback" }],
      news: [{ url: "https://second.test", snippet: "fallback" }],
    } as any;
    const urls = searchHighlightURLs(response);

    const result = await runIndexedSearchHighlightsShadow(
      urls,
      "query",
      logger,
      "request-1",
    );

    expect(generateHighlightsIndexedBatch).toHaveBeenCalledWith(
      "query",
      [
        {
          id: "0",
          url: "https://first.test",
          indexObject: "index:https://first.test.json",
        },
        {
          id: "1",
          url: "https://second.test",
          indexObject: "index:https://second.test.json",
        },
      ],
      {
        logger,
        logPayload: false,
        requestId: "request-1",
        timeoutMs: null,
        onFailure: expect.any(Function),
      },
    );
    expect(result).toEqual({
      attempted: 2,
      indexHits: 2,
      replaced: 1,
      succeeded: true,
    });
  });
});

describe("applyIndexedSearchHighlights", () => {
  it("uses the shadow indexed request path and applies web and news responses by ID", async () => {
    vi.mocked(generateHighlightsIndexedBatch).mockResolvedValue(
      new Map([
        ["0", { highlights: [], markdown: "first highlight" }],
        ["1", { highlights: [], markdown: "second highlight" }],
      ]),
    );
    const response = {
      web: [{ url: "https://first.test", description: "first fallback" }],
      news: [{ url: "https://second.test", snippet: "second fallback" }],
    } as any;

    const result = await applyIndexedSearchHighlights(
      response,
      "query",
      logger,
      "request-1",
    );

    expect(generateHighlightsIndexedBatch).toHaveBeenCalledWith(
      "query",
      [
        {
          id: "0",
          url: "https://first.test",
          indexObject: "index:https://first.test.json",
        },
        {
          id: "1",
          url: "https://second.test",
          indexObject: "index:https://second.test.json",
        },
      ],
      {
        logger,
        logPayload: false,
        requestId: "request-1",
        timeoutMs: null,
        onFailure: expect.any(Function),
      },
    );
    expect(generateHighlightsBatch).not.toHaveBeenCalled();
    expect(response.web[0].description).toBe("first highlight");
    expect(response.news[0].snippet).toBe("second highlight");
    expect(result).toEqual({
      attempted: 2,
      indexHits: 2,
      replaced: 2,
      succeeded: true,
    });
  });

  it("preserves provider snippets when the indexed Chain request fails", async () => {
    vi.mocked(generateHighlightsIndexedBatch).mockResolvedValue(null);
    const response = {
      web: [{ url: "https://first.test", description: "first fallback" }],
      news: [{ url: "https://second.test", snippet: "second fallback" }],
    } as any;

    const result = await applyIndexedSearchHighlights(
      response,
      "query",
      logger,
      "request-1",
    );

    expect(response.web[0].description).toBe("first fallback");
    expect(response.news[0].snippet).toBe("second fallback");
    expect(result).toEqual({
      attempted: 2,
      indexHits: 2,
      replaced: 0,
      succeeded: false,
    });
  });
});

describe("applySearchHighlights", () => {
  it("enables the in-cluster service without requiring a bearer token", () => {
    const token = config.HIGHLIGHT_MODEL_TOKEN;
    config.HIGHLIGHT_MODEL_TOKEN = undefined;

    try {
      expect(highlightsEnvReady()).toBe(true);
    } finally {
      config.HIGHLIGHT_MODEL_TOKEN = token;
    }
  });

  it("sends indexed web and news results in one batch and applies responses by ID", async () => {
    vi.mocked(generateHighlightsBatch).mockResolvedValue(
      new Map([
        ["0", { highlights: [], markdown: "first highlight" }],
        ["1", { highlights: [], markdown: "second highlight" }],
      ]),
    );
    const response = {
      web: [{ url: "https://first.test", description: "first fallback" }],
      news: [{ url: "https://second.test", snippet: "second fallback" }],
    } as any;

    const result = await applySearchHighlights(response, "query", logger);

    expect(generateHighlightsBatch).toHaveBeenCalledTimes(1);
    expect(generateHighlightsBatch).toHaveBeenCalledWith(
      "query",
      [
        {
          id: "0",
          markdown: "markdown:<main>index:https://first.test.json</main>",
        },
        {
          id: "1",
          markdown: "markdown:<main>index:https://second.test.json</main>",
        },
      ],
      {
        logger,
        onFailure: expect.any(Function),
      },
    );
    expect(response.web[0].description).toBe("first highlight");
    expect(response.news[0].snippet).toBe("second highlight");
    expect(result).toEqual({
      attempted: 2,
      indexHits: 2,
      replaced: 2,
      succeeded: true,
    });
  });

  it("preserves individual fallbacks for missing and empty batch pages", async () => {
    vi.mocked(generateHighlightsBatch).mockResolvedValue(
      new Map([["0", { highlights: [], markdown: "   " }]]),
    );
    const response = {
      web: [
        { url: "https://first.test", description: "first fallback" },
        { url: "https://second.test", description: "second fallback" },
      ],
    } as any;

    const result = await applySearchHighlights(response, "query", logger);

    expect(response.web.map((item: any) => item.description)).toEqual([
      "first fallback",
      "second fallback",
    ]);
    expect(result).toEqual({
      attempted: 2,
      indexHits: 2,
      replaced: 0,
      succeeded: true,
    });
  });

  it("preserves every fallback when the batch request fails", async () => {
    vi.mocked(generateHighlightsBatch).mockResolvedValue(null);
    const response = {
      web: [
        { url: "https://first.test", description: "first fallback" },
        { url: "https://second.test", description: "second fallback" },
      ],
    } as any;

    const result = await applySearchHighlights(response, "query", logger);

    expect(response.web.map((item: any) => item.description)).toEqual([
      "first fallback",
      "second fallback",
    ]);
    expect(result).toEqual({
      attempted: 2,
      indexHits: 2,
      replaced: 0,
      succeeded: false,
    });
  });

  it("runs without mutating the response or logging payloads in shadow mode", async () => {
    vi.mocked(generateHighlightsBatch).mockResolvedValue(
      new Map([["0", { highlights: [], markdown: "shadow highlight" }]]),
    );
    const response = {
      web: [{ url: "https://first.test", description: "fallback" }],
    } as any;

    const result = await applySearchHighlights(response, "query", logger, {
      applyResults: false,
      suppressSummaryLog: true,
      suppressPayloadLog: true,
      allowLegacyFallback: false,
    });

    expect(response.web[0].description).toBe("fallback");
    expect(result).toEqual({
      attempted: 1,
      indexHits: 1,
      replaced: 1,
      succeeded: true,
    });
    expect(generateHighlightsBatch).toHaveBeenCalledWith(
      "query",
      expect.any(Array),
      {
        logger,
        logPayload: false,
        allowLegacyFallback: false,
        onFailure: expect.any(Function),
      },
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "Search highlights applied",
      expect.anything(),
    );
  });

  it("omits result URLs from shadow lookup failures", async () => {
    vi.mocked(indexGetRecent5).mockRejectedValueOnce(
      new Error("lookup failed"),
    );
    const response = {
      web: [{ url: "https://private.test", description: "fallback" }],
    } as any;

    await applySearchHighlights(response, "query", logger, {
      applyResults: false,
      suppressSummaryLog: true,
      suppressPayloadLog: true,
      allowLegacyFallback: false,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "highlights: index lookup failed",
      {
        error: "lookup failed",
      },
    );
  });
});
