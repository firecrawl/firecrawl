vi.mock("../config", () => ({
  config: {
    HIGHLIGHT_MODEL_URL: "https://highlight.test",
    HIGHLIGHT_MODEL_TOKEN: "secret-token",
  },
}));

import {
  generateHighlightsBatch,
  generateHighlightsIndexedBatch,
} from "./highlight-model";
import { config } from "../config";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("generateHighlightsBatch", () => {
  it("posts lightweight index references to the indexed Stage 1 endpoint", async () => {
    const fetchMock = mockFetchOnce({ pages: [] });

    await generateHighlightsIndexedBatch(
      "q1",
      [
        {
          id: "0",
          url: "https://first.test/path",
          indexObject: "index-object.json",
        },
      ],
      { logger, logPayload: false, requestId: "request-1" },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://highlight.test/batch_highlight_indexed");
    expect(JSON.parse(init.body)).toEqual({
      query: "q1",
      pages: [
        {
          id: "0",
          url: "https://first.test/path",
          indexObject: "index-object.json",
        },
      ],
    });
  });

  it("posts every page to one /batch_highlight call with the bearer token", async () => {
    const fetchMock = mockFetchOnce({ pages: [] });

    await generateHighlightsBatch(
      "q1",
      [
        { id: "0", markdown: "# First\n\nbody text" },
        { id: "1", markdown: "# Second\n\nmore text" },
      ],
      { logger, requestId: "request-1" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://highlight.test/batch_highlight");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(init.headers["X-Request-ID"]).toBe("request-1");

    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      query: "q1",
      pages: [
        { id: "0", markdown: "# First\n\nbody text" },
        { id: "1", markdown: "# Second\n\nmore text" },
      ],
    });
  });

  it("omits bearer auth for the in-cluster service when no token is configured", async () => {
    const token = config.HIGHLIGHT_MODEL_TOKEN;
    config.HIGHLIGHT_MODEL_TOKEN = undefined;
    const fetchMock = mockFetchOnce({ pages: [] });

    try {
      await generateHighlightsBatch("q1", [{ id: "0", markdown: "markdown" }], {
        logger,
      });
    } finally {
      config.HIGHLIGHT_MODEL_TOKEN = token;
    }

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("returns successful pages keyed by ID and leaves missing pages absent", async () => {
    mockFetchOnce({
      pages: [
        {
          id: "1",
          cache: "hit",
          output: {
            highlights: [
              { block_index: 0, score: 0.9 },
              { block_index: 2, score: 0.5 },
            ],
            markdown: "reassembled answer",
          },
        },
        { id: "invalid-without-output" },
      ],
    });

    const out = await generateHighlightsBatch(
      "q",
      [
        { id: "0", markdown: "missing" },
        { id: "1", markdown: "some markdown" },
      ],
      { logger },
    );

    expect(out?.get("0")).toBeUndefined();
    expect(out?.get("1")).toEqual({
      highlights: [
        { block_index: 0, score: 0.9 },
        { block_index: 2, score: 0.5 },
      ],
      markdown: "reassembled answer",
    });
  });

  it("debug-logs batch coverage and highlights", async () => {
    mockFetchOnce({
      pages: [
        {
          id: "page-1",
          output: {
            highlights: [{ block_index: 1, score: 0.8 }],
            markdown: "x",
          },
        },
      ],
    });

    await generateHighlightsBatch("q", [{ id: "page-1", markdown: "md" }], {
      logger,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      "query highlights batch",
      expect.objectContaining({
        canonicalLog: "search/highlights",
        requestedPages: 1,
        returnedPages: 1,
        pages: [
          {
            id: "page-1",
            highlights: [{ block_index: 1, score: 0.8 }],
          },
        ],
      }),
    );
  });

  it("defaults missing pages to an empty result map", async () => {
    mockFetchOnce({});

    const out = await generateHighlightsBatch(
      "q",
      [{ id: "0", markdown: "md" }],
      { logger },
    );

    expect(out).toEqual(new Map());
  });

  it("does not call the service for an empty batch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateHighlightsBatch("q", [], { logger });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual(new Map());
  });

  it("returns null when the service errors", async () => {
    mockFetchOnce({ error: "boom" }, false, 500);
    const onFailure = vi.fn();

    const out = await generateHighlightsBatch(
      "q",
      [{ id: "0", markdown: "md" }],
      { logger, onFailure },
    );

    expect(out).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith("http_5xx");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("retries one transient server failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "unavailable",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ pages: [] }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateHighlightsBatch(
      "q",
      [{ id: "0", markdown: "md" }],
      { logger },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual(new Map());
  });

  it.each([null, []])(
    "classifies malformed JSON response %j as invalid",
    async body => {
      mockFetchOnce(body);
      const onFailure = vi.fn();

      const out = await generateHighlightsBatch(
        "q",
        [{ id: "0", markdown: "md" }],
        { logger, onFailure },
      );

      expect(out).toBeNull();
      expect(onFailure).toHaveBeenCalledWith("invalid_response");
    },
  );

  it("does not retry after the request deadline aborts during backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                status: 503,
                text: async () => "unavailable",
              }),
            29_990,
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onFailure = vi.fn();

    const resultPromise = generateHighlightsBatch(
      "q",
      [{ id: "0", markdown: "md" }],
      { logger, onFailure },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await resultPromise;

    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith("timeout");
  });

  it("falls back to legacy per-page calls while the old service URL is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "legacy batch contract",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ markdown: "first legacy highlight" }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "page failed",
      });
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateHighlightsBatch(
      "q",
      [
        { id: "0", markdown: "first" },
        { id: "1", markdown: "second" },
      ],
      { logger },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://highlight.test/batch_highlight",
      "https://highlight.test/highlight",
      "https://highlight.test/highlight",
    ]);
    expect(out).toEqual(
      new Map([["0", { highlights: [], markdown: "first legacy highlight" }]]),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "legacy query highlight failed",
      expect.objectContaining({ pageId: "1" }),
    );
  });

  it("does not fan out fallback requests when fallback is disabled", async () => {
    const fetchMock = mockFetchOnce({ error: "not found" }, false, 404);

    const out = await generateHighlightsBatch(
      "q",
      [
        { id: "0", markdown: "first" },
        { id: "1", markdown: "second" },
      ],
      { logger, allowLegacyFallback: false, logPayload: false },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toBeNull();
  });
});
