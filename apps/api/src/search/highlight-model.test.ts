vi.mock("../config", () => ({
  config: {
    HIGHLIGHT_MODEL_URL: "https://highlight.test",
    HIGHLIGHT_MODEL_TOKEN: "secret-token",
  },
}));

import { generateHighlights } from "./highlight-model";

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("generateHighlights", () => {
  it("posts the query and full markdown to /highlight with the bearer token", async () => {
    const fetchMock = mockFetchOnce({ highlights: [], markdown: "" });

    await generateHighlights("q1", "# Page\n\nbody text", { logger });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://highlight.test/highlight");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-token");

    const sent = JSON.parse(init.body);
    expect(sent).toEqual({ query: "q1", markdown: "# Page\n\nbody text" });
  });

  it("returns the highlights and reassembled markdown from the service", async () => {
    mockFetchOnce({
      highlights: [
        { block_index: 0, score: 0.9 },
        { block_index: 2, score: 0.5 },
      ],
      markdown: "reassembled answer",
    });

    const out = await generateHighlights("q", "some markdown", { logger });

    expect(out).toEqual({
      highlights: [
        { block_index: 0, score: 0.9 },
        { block_index: 2, score: 0.5 },
      ],
      markdown: "reassembled answer",
    });
  });

  it("debug-logs the highlights array", async () => {
    mockFetchOnce({
      highlights: [{ block_index: 1, score: 0.8 }],
      markdown: "x",
    });

    await generateHighlights("q", "md", { logger });

    expect(logger.debug).toHaveBeenCalledWith(
      "query highlights",
      expect.objectContaining({
        canonicalLog: "search/highlights",
        highlights: [{ block_index: 1, score: 0.8 }],
      }),
    );
  });

  it("defaults missing fields to empty highlights and markdown", async () => {
    mockFetchOnce({});

    const out = await generateHighlights("q", "md", { logger });

    expect(out).toEqual({ highlights: [], markdown: "" });
  });

  it("returns null when the service errors", async () => {
    mockFetchOnce({ error: "boom" }, false, 500);

    const out = await generateHighlights("q", "md", { logger });

    expect(out).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
