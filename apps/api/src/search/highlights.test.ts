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
}));

import { generateHighlightsBatch } from "./highlight-model";
import { config } from "../config";
import { applySearchHighlights, highlightsEnvReady } from "./highlights";

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
      { logger },
    );
    expect(response.web[0].description).toBe("first highlight");
    expect(response.news[0].snippet).toBe("second highlight");
    expect(result).toEqual({ attempted: 2, indexHits: 2, replaced: 2 });
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
    expect(result).toEqual({ attempted: 2, indexHits: 2, replaced: 0 });
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
    expect(result).toEqual({ attempted: 2, indexHits: 2, replaced: 0 });
  });
});
