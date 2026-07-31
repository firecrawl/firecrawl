vi.mock("../config", () => ({
  config: {
    GCS_INDEX_BUCKET_NAME: "index-bucket",
    HIGHLIGHT_MODEL_URL: "https://highlight.test",
    HIGHLIGHT_MODEL_TOKEN: "secret-token",
    HIGHLIGHT_ROLLOUT_PERCENT: 0,
  },
}));

vi.mock("../services", () => ({
  useIndex: true,
  normalizeURLForIndex: vi.fn((url: string) => url),
  hashURL: vi.fn((url: string) => url),
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

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./highlight-model", () => ({
  generateHighlightsIndexedBatch: vi.fn(),
}));

import { generateHighlightsIndexedBatch } from "./highlight-model";
import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import {
  highlightsEnvReady,
  runIndexedSearchHighlights,
  searchHighlightsMode,
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

describe("runIndexedSearchHighlights", () => {
  it("enables the in-cluster service without requiring a bearer token", () => {
    const token = config.HIGHLIGHT_MODEL_TOKEN;
    config.HIGHLIGHT_MODEL_TOKEN = undefined;

    try {
      expect(highlightsEnvReady()).toBe(true);
    } finally {
      config.HIGHLIGHT_MODEL_TOKEN = token;
    }
  });

  it("uses indexed references and applies web and news responses", async () => {
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

    const result = await runIndexedSearchHighlights(response, "query", logger, {
      mode: "apply",
      requestId: "request-1",
      teamId: "team-1",
    });

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
        timeoutMs: 3000,
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
    expect(logger.info).toHaveBeenCalledWith(
      "Search highlights completed",
      expect.objectContaining({ mode: "apply", applied: 2 }),
    );
  });

  it("runs the same indexed path without mutating the response in shadow mode", async () => {
    vi.mocked(generateHighlightsIndexedBatch).mockResolvedValue(
      new Map([["0", { highlights: [], markdown: "shadow highlight" }]]),
    );
    const response = {
      web: [{ url: "https://first.test", description: "fallback" }],
    } as any;

    const result = await runIndexedSearchHighlights(response, "query", logger, {
      mode: "shadow",
      requestId: "request-1",
      teamId: "team-1",
    });

    expect(response.web[0].description).toBe("fallback");
    expect(result).toEqual({
      attempted: 1,
      indexHits: 1,
      replaced: 1,
      succeeded: true,
    });
    expect(generateHighlightsIndexedBatch).toHaveBeenCalledWith(
      "query",
      expect.any(Array),
      expect.objectContaining({
        logger: expect.objectContaining({ silent: true }),
        logPayload: false,
      }),
    );
    expect(rootLogger.info).toHaveBeenCalledWith(
      "Search highlights completed",
      expect.objectContaining({ mode: "shadow", wouldApply: 1 }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("preserves provider snippets when the indexed request fails", async () => {
    vi.mocked(generateHighlightsIndexedBatch).mockResolvedValue(null);
    const response = {
      web: [{ url: "https://first.test", description: "first fallback" }],
    } as any;

    const result = await runIndexedSearchHighlights(response, "query", logger, {
      mode: "apply",
      requestId: "request-1",
      teamId: "team-1",
    });

    expect(response.web[0].description).toBe("first fallback");
    expect(result).toEqual({
      attempted: 1,
      indexHits: 1,
      replaced: 0,
      succeeded: false,
    });
  });
});

describe("searchHighlightsMode", () => {
  const base = {
    cohortKey: "api-key:123",
    rolloutPercent: 0,
  };

  it("applies omitted highlights for MCP and CLI callers", () => {
    expect(searchHighlightsMode({ ...base, origin: "mcp" })).toBe("apply");
    expect(searchHighlightsMode({ ...base, origin: "mcp-fastmcp" })).toBe(
      "apply",
    );
    expect(searchHighlightsMode({ ...base, integration: "cli" })).toBe("apply");
  });

  it("honors explicit response selection before caller defaults", () => {
    expect(searchHighlightsMode({ ...base, requested: true })).toBe("apply");
    expect(
      searchHighlightsMode({ ...base, requested: false, origin: "mcp" }),
    ).toBe("shadow");
  });

  it("uses the rollout percentage for other callers", () => {
    expect(searchHighlightsMode({ ...base, rolloutPercent: 0 })).toBe("shadow");
    expect(searchHighlightsMode({ ...base, rolloutPercent: 100 })).toBe(
      "apply",
    );

    const first = searchHighlightsMode({ ...base, rolloutPercent: 50 });
    expect(searchHighlightsMode({ ...base, rolloutPercent: 50 })).toBe(first);
  });
});
