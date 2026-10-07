import {
  computeAgentHintSignals,
  type AgentHintSignalContext,
} from "./agent-hint-signals";

const signalsFor = (overrides: Partial<AgentHintSignalContext>) =>
  Object.fromEntries(
    computeAgentHintSignals({
      endpoint: "search",
      response: { success: true, data: {} },
      ...overrides,
    }),
  );

describe("agent hint signals", () => {
  it("always reports the endpoint, outcome and capabilities", () => {
    expect(signalsFor({})).toEqual({
      endpoint: "search",
      success: true,
      can_use_map_and_crawl: false,
      can_use_interact: false,
    });
    expect(
      signalsFor({
        endpoint: "map",
        response: { success: false, error: "failed" },
        canUseMapAndCrawl: true,
        canUseInteract: true,
        remainingCredits: 42,
      }),
    ).toEqual({
      endpoint: "map",
      success: false,
      can_use_map_and_crawl: true,
      can_use_interact: true,
      remaining_credits: 42,
    });
  });

  it("omits non-finite remaining credits", () => {
    expect(signalsFor({ remainingCredits: Infinity })).not.toHaveProperty(
      "remaining_credits",
    );
  });

  it("describes the scraped page from metadata", () => {
    expect(
      signalsFor({
        endpoint: "scrape",
        response: {
          success: true,
          data: {
            metadata: {
              statusCode: 410,
              scrapeId: "id with space",
              sourceURL: "https://old.example/a",
              url: "https://new.example/docs/getting-started.html",
            },
          },
        },
      }),
    ).toMatchObject({
      page_status: 410,
      scrape_id: "id%20with%20space",
      page_redirect_from: '"https://old.example/a"',
      page_redirect_to: '"https://new.example/docs/getting-started.html"',
      page_host: "new.example",
      page_path_words: "docs getting started",
    });
  });

  it("falls back to the top-level scrape ID", () => {
    expect(
      signalsFor({
        endpoint: "scrape",
        response: { success: true, scrape_id: "top", data: { metadata: {} } },
      }),
    ).toMatchObject({ scrape_id: "top" });
  });

  it("omits redirect values when the URLs match or are too long to quote", () => {
    const page = (sourceURL: string, url: string) =>
      signalsFor({
        endpoint: "scrape",
        response: { success: true, data: { metadata: { sourceURL, url } } },
      });
    expect(
      page("https://a.example/x", "https://a.example/x"),
    ).not.toHaveProperty("page_redirect_from");
    expect(
      page("https://a.example/x", `https://b.example/${"y".repeat(300)}`),
    ).not.toHaveProperty("page_redirect_from");
  });

  it("omits path words when only opaque ids remain", () => {
    const result = signalsFor({
      endpoint: "scrape",
      response: {
        success: true,
        data: { metadata: { url: "https://x.example/12345" } },
      },
    });
    expect(result).toMatchObject({ page_host: "x.example" });
    expect(result).not.toHaveProperty("page_path_words");
  });

  it("reports document page counts with the requestable remainder", () => {
    expect(
      signalsFor({
        endpoint: "scrape",
        response: {
          success: true,
          data: { metadata: { numPages: 5, totalPages: 12000 } },
        },
      }),
    ).toMatchObject({
      document_pages_returned: 5,
      document_pages_total: 12000,
      document_max_pages: 10000,
      document_pages_requestable: 9995,
    });
  });

  it("never reports a negative requestable page count", () => {
    expect(
      signalsFor({
        endpoint: "scrape",
        response: {
          success: true,
          data: { metadata: { numPages: 12, totalPages: 5 } },
        },
      }),
    ).toMatchObject({ document_pages_requestable: 0 });
  });

  it("summarises web results, excerpts and origins", () => {
    expect(
      signalsFor({
        response: {
          success: true,
          data: {
            web: [
              { url: "https://docs.example.com/a", markdown: "a" },
              { url: "https://docs.example.com/b", position: 7 },
              { url: "https://docs.example.com/c", html: "" },
              { url: "javascript:alert(1)" },
              { description: "no url" },
            ],
          },
        },
      }),
    ).toMatchObject({
      result_count: 5,
      excerpt_count: 2,
      excerpt_share: 0.4,
      excerpt_results: ['#7 "https://docs.example.com/b"', "#4"],
      origin_result_count: 3,
      top_origin: "https://docs.example.com",
      top_origin_count: 3,
      top_origin_share: 1,
    });
  });

  it("reads results from a top-level data array and reports empty sets", () => {
    expect(signalsFor({ response: { success: true, data: [] } })).toMatchObject(
      { result_count: 0, excerpt_count: 0, origin_result_count: 0 },
    );
    expect(
      signalsFor({ response: { success: true, data: { web: [] } } }),
    ).not.toHaveProperty("excerpt_share");
  });

  it("reports no result signals without a web result collection", () => {
    expect(
      signalsFor({ response: { success: true, data: { images: [] } } }),
    ).not.toHaveProperty("result_count");
  });
});
