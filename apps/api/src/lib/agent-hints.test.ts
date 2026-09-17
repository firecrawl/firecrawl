import { buildAgentHints, type AgentHintContext } from "./agent-hints";

const fullTool = {
  provider: "zillow",
  capability: "properties/property",
  options: [],
  response: { fields: [] },
};
const call = {
  provider: "firecrawl",
  capability: "find-tools",
  options: { providers: ["zillow"] },
};
const catalogue = (data: unknown) => ({
  success: true,
  data: {
    alexandria: [{ provider: "firecrawl", capability: "find-tools", data }],
  },
});
const hints = (overrides: Partial<AgentHintContext>) =>
  buildAgentHints({
    endpoint: "search",
    response: { success: true, data: {} },
    ...overrides,
  });

describe("deterministic agent hints", () => {
  it("never labels tool count as relevance or expands full definitions again", () => {
    const result = hints({
      response: { success: true, data: { tools: [fullTool] } },
    });
    expect(result.join(" ")).toContain("matching your task");
    expect(result.join(" ")).not.toMatch(
      /relevant|rental|expand|next request/i,
    );
  });

  it("checks missing full content per result and does not scrape everything", () => {
    expect(
      hints({
        response: {
          success: true,
          data: { web: [{ url: "https://example.com", markdown: "full" }] },
        },
      }),
    ).toEqual([]);
    const result = hints({
      response: {
        success: true,
        data: {
          web: [
            { url: "https://example.com", markdown: "full" },
            { url: "https://example.org", description: "excerpt" },
          ],
        },
      },
    });
    expect(result.join(" ")).toContain("POST /v2/scrape");
    expect(result.join(" ").toLowerCase()).toContain("if you need");
  });

  it("selects only one cross-endpoint hint when both tools and excerpts exist", () => {
    const result = hints({
      response: {
        success: true,
        data: { tools: [fullTool], web: [{ url: "https://example.com" }] },
      },
    });
    expect(result).toHaveLength(1);
    expect(result.join(" ")).not.toContain('"url"');
  });

  it("distinguishes summary expansion from catalogue paging within the two-hint cap", () => {
    const result = hints({
      endpoint: "scrape",
      response: catalogue({ items: [{ next: call }], next: call }),
    });
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.join(" ")).toContain("full input and output definitions");
    expect(result.join(" ")).toContain("item's next");
    expect(result.join(" ")).not.toContain("More tools");
  });

  it("accepts a continuation with defaulted options", () => {
    const result = hints({
      endpoint: "scrape",
      response: catalogue({
        level: "tools",
        items: [],
        total: 12,
        next: { provider: "firecrawl", capability: "find-tools" },
      }),
    });
    expect(result.join(" ")).toContain("More tools");
    expect(result.join(" ")).not.toContain("POST /v2/search");
  });

  it("offers web search for this empty lookup only when it has no continuation", () => {
    expect(
      hints({
        endpoint: "scrape",
        response: catalogue({ items: [], next: null }),
      }).join(" "),
    ).toContain("This catalogue lookup");
    expect(
      hints({
        endpoint: "scrape",
        response: catalogue({ items: [], next: call }),
      }).join(" "),
    ).not.toContain("POST /v2/search");
  });

  it("uses explicit page status instead of API 404s such as cache misses", () => {
    const result = hints({
      endpoint: "scrape",
      response: { success: true, data: { metadata: { statusCode: 404 } } },
    });
    expect(result.join(" ")).toContain("POST /v2/search");
    for (const code of [403, 429, 500]) {
      expect(
        hints({
          endpoint: "scrape",
          response: { success: true, data: { metadata: { statusCode: code } } },
        }),
      ).toEqual([]);
    }
    expect(
      hints({
        endpoint: "scrape",
        response: {
          success: false,
          code: "SCRAPE_NO_CACHED_DATA",
          error: "Not cached",
        },
      }),
    ).toEqual([]);
  });

  it("prioritizes missing-page recovery over domain tool promotion", () => {
    const result = hints({
      endpoint: "scrape",
      response: {
        success: true,
        data: { tools: [fullTool], metadata: { statusCode: 410 } },
      },
    });
    expect(result.join(" ")).toContain("POST /v2/search");
    expect(result.join(" ")).not.toContain("Alexandria tool definitions");
  });

  it("prioritizes a typed find-tools query correction over promotion and paging", () => {
    const result = hints({
      endpoint: "scrape",
      request: { alexandria: { ...call, options: { query: "rentals" } } },
      response: {
        success: true,
        data: {
          alexandria: [
            { ...call, error: { code: "invalid_option", message: "invalid" } },
          ],
        },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("does not accept query");
    expect(result[0]).toContain('"query":"rentals"');
  });

  it("preserves a top-level typed rejection while supplying the query correction", () => {
    const result = hints({
      endpoint: "scrape",
      request: { alexandria: { ...call, options: { query: "rentals" } } },
      response: {
        success: false,
        code: "invalid_option",
        error: "Find Tools does not take query",
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("does not accept query");
  });

  it("does not turn provider-result errors into a success workflow", () => {
    expect(
      hints({
        endpoint: "scrape",
        response: {
          success: true,
          data: {
            alexandria: [{ error: { code: "unknown", message: "failed" } }],
          },
        },
      }),
    ).toEqual([]);
  });

  it("does not add static feedback guidance to otherwise hint-free results", () => {
    expect(hints({ response: { success: true, data: { web: [] } } })).toEqual(
      [],
    );
    expect(hints({ response: { success: false, error: "failed" } })).toEqual(
      [],
    );
  });
});
