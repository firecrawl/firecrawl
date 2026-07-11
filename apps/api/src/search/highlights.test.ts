vi.mock("../config", () => ({
  config: {
    GCS_INDEX_BUCKET_NAME: "test-bucket",
    HIGHLIGHT_MODEL_URL: "https://highlight.test",
    HIGHLIGHT_MODEL_TOKEN: "secret-token",
  },
}));

vi.mock("../services", () => ({
  useIndex: true,
  normalizeURLForIndex: (url: string) => url,
  hashURL: () => "url-hash",
  getIndexFromGCS: vi.fn().mockResolvedValue({
    html: "<html><body><p>indexed page content</p></body></html>",
  }),
}));

vi.mock("../db/rpc", () => ({
  indexGetRecent5: vi
    .fn()
    .mockResolvedValue([
      { id: "index-entry", status: 200, created_at: "2026-07-01T00:00:00Z" },
    ]),
}));

vi.mock("../lib/html-to-markdown", () => ({
  parseMarkdown: vi.fn().mockResolvedValue("indexed page content"),
}));

vi.mock("../scraper/scrapeURL/lib/removeUnwantedElements", () => ({
  htmlTransform: vi.fn().mockResolvedValue("<p>indexed page content</p>"),
}));

vi.mock("./highlight-model", () => ({
  generateHighlights: vi.fn(),
}));

import type { SearchV2Response } from "../lib/entities";
import { applySearchHighlights } from "./highlights";
import { generateHighlights } from "./highlight-model";
import { indexGetRecent5 } from "../db/rpc";
import { getIndexFromGCS } from "../services";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as any;
logger.child.mockReturnValue(logger);

function makeResponse(): SearchV2Response {
  return {
    web: [
      {
        url: "https://example.com",
        title: "Example",
        description: "provider snippet",
      },
    ],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("applySearchHighlights", () => {
  it("replaces snippets and canonical-logs time taken at debug when within the timeout", async () => {
    vi.mocked(generateHighlights).mockResolvedValue({
      highlights: [],
      markdown: "relevant highlight",
    });

    const response = makeResponse();
    const out = await applySearchHighlights(response, "query", logger);

    expect(out).toEqual({
      attempted: 1,
      indexHits: 1,
      replaced: 1,
      timedOut: false,
    });
    expect(response.web![0].description).toBe("relevant highlight");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "Search highlights applied",
      expect.objectContaining({
        canonicalLog: "search/highlights",
        attempted: 1,
        indexHits: 1,
        replaced: 1,
        timedOut: false,
        timeTakenMs: expect.any(Number),
        timeoutMs: 300,
      }),
    );
  });

  it("keeps provider snippets and warns when the 300ms cap fires", async () => {
    // Model call resolves only well past the cap (or on abort).
    vi.mocked(generateHighlights).mockImplementation(
      (_query, _markdown, opts) =>
        new Promise(resolve => {
          const late = setTimeout(
            () => resolve({ highlights: [], markdown: "too late" }),
            2000,
          );
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(late);
            resolve(null);
          });
        }),
    );

    const response = makeResponse();
    const out = await applySearchHighlights(response, "query", logger);

    expect(out.timedOut).toBe(true);
    expect(out.replaced).toBe(0);
    expect(response.web![0].description).toBe("provider snippet");
    expect(logger.warn).toHaveBeenCalledWith(
      "Search highlights timed out",
      expect.objectContaining({
        canonicalLog: "search/highlights",
        timedOut: true,
        timeTakenMs: expect.any(Number),
        timeoutMs: 300,
      }),
    );
  });

  it("stops the index pipeline at the next stage boundary after timeout", async () => {
    // The index DB lookup only resolves past the cap; the dangling work must
    // bail at the abort checkpoint instead of fetching from GCS and parsing.
    vi.mocked(indexGetRecent5).mockImplementationOnce(
      () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve([
                {
                  id: "index-entry",
                  status: 200,
                  created_at: "2026-07-01T00:00:00Z",
                },
              ] as any),
            450,
          ),
        ),
    );

    const response = makeResponse();
    const out = await applySearchHighlights(response, "query", logger);

    expect(out.timedOut).toBe(true);
    expect(response.web![0].description).toBe("provider snippet");

    // Let the dangling lookup resolve, then confirm downstream stages never ran.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(getIndexFromGCS).not.toHaveBeenCalled();
    expect(generateHighlights).not.toHaveBeenCalled();
  });

  it("canonical-logs time taken even when there is nothing to highlight", async () => {
    const out = await applySearchHighlights({ web: [] }, "query", logger);

    expect(out).toEqual({
      attempted: 0,
      indexHits: 0,
      replaced: 0,
      timedOut: false,
    });
    expect(generateHighlights).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "Search highlights applied",
      expect.objectContaining({
        canonicalLog: "search/highlights",
        attempted: 0,
        timeTakenMs: expect.any(Number),
      }),
    );
  });
});
