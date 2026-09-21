import { buildAgentHints, type AgentHintContext } from "./agent-hints";

const hints = (overrides: Partial<AgentHintContext>) =>
  buildAgentHints({
    endpoint: "search",
    response: { success: true, data: {} },
    ...overrides,
  });

describe("deterministic agent hints", () => {
  it.each(["markdown", "html", "rawHtml"])(
    "treats a search result with %s as full content",
    contentField => {
      expect(
        hints({
          response: {
            success: true,
            data: {
              web: [{ url: "https://example.com", [contentField]: "full" }],
            },
          },
        }),
      ).toEqual([]);
    },
  );

  it.each(["markdown", "html", "rawHtml"])(
    "treats a present but empty %s field as fetched content",
    contentField => {
      expect(
        hints({
          response: {
            success: true,
            data: {
              web: [{ url: "https://example.com", [contentField]: "" }],
            },
          },
        }),
      ).toEqual([]);
    },
  );

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

  it("suggests another search when the web result set is explicitly empty", () => {
    expect(
      hints({ response: { success: true, data: { web: [] } } }).join(" "),
    ).toContain("POST /v2/search");
    expect(
      hints({
        response: {
          success: true,
          data: { images: [{ imageUrl: "https://example.com/image.png" }] },
        },
      }),
    ).toEqual([]);

    const missingContentWins = hints({
      response: {
        success: true,
        data: {
          web: [
            { url: "https://docs.example.com/a" },
            { url: "https://docs.example.com/b", markdown: "b" },
            { url: "https://docs.example.com/c", markdown: "c" },
            { url: "https://other.example.com/d", markdown: "d" },
          ],
        },
      },
    }).join(" ");
    expect(missingContentWins).toContain("POST /v2/scrape");
    expect(missingContentWins).not.toContain("POST /v2/map");
    expect(missingContentWins).not.toContain("POST /v2/crawl");
  });

  it("suggests mapping or crawling when results cluster on one origin", () => {
    const clustered = hints({
      response: {
        success: true,
        data: {
          web: [
            { url: "https://docs.example.com/a", markdown: "a" },
            { url: "https://docs.example.com/b", html: "b" },
            { url: "https://docs.example.com/c", rawHtml: "c" },
            { url: "https://other.example.com/d", markdown: "d" },
          ],
        },
      },
    }).join(" ");
    expect(clustered).toContain("https://docs.example.com");
    expect(clustered).toContain("POST /v2/map");
    expect(clustered).toContain("POST /v2/crawl");

    expect(
      hints({
        response: {
          success: true,
          data: {
            web: [
              { url: "https://docs.example.com/a", markdown: "a" },
              { url: "https://docs.example.com/b", markdown: "b" },
              { url: "https://docs.example.com/c", markdown: "c" },
            ],
          },
        },
      }),
    ).toEqual([]);

    expect(
      hints({
        response: {
          success: true,
          data: {
            web: [
              { url: "https://docs.example.com/a", markdown: "a" },
              { url: "https://docs.example.com/b", markdown: "b" },
              { url: "https://other.example.com/c", markdown: "c" },
              { url: "https://another.example.com/d", markdown: "d" },
            ],
          },
        },
      }),
    ).toEqual([]);

    expect(
      hints({
        response: {
          success: true,
          data: {
            web: [
              { url: "https://docs.example.com/a", markdown: "a" },
              { url: "https://docs.example.com/b", markdown: "b" },
              { url: "https://docs.example.com/c", markdown: "c" },
              { url: "mailto:docs@example.com", markdown: "d" },
              { url: "not a URL", markdown: "e" },
            ],
          },
        },
      }),
    ).toEqual([]);
  });

  it.each(["parse", "map"] as const)(
    "%s emits no cross-endpoint hint and only the low-credit notice",
    endpoint => {
      const response = {
        success: true,
        data: {
          web: [{ url: "https://example.com", description: "excerpt" }],
          metadata: { statusCode: 404 },
        },
      };
      expect(hints({ endpoint, response })).toEqual([]);
      expect(hints({ endpoint, response, remainingCredits: 99 })).toEqual([
        "The connected Firecrawl account is low on credits. Let the user know they should add more credits.",
      ]);
    },
  );

  it("uses explicit page status instead of API 404s such as cache misses", () => {
    for (const code of [404, 410]) {
      const result = hints({
        endpoint: "scrape",
        response: { success: true, data: { metadata: { statusCode: code } } },
      });
      expect(result.join(" ")).toContain("POST /v2/search");
    }
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

  it("suggests interact only for a 401 scrape with a scrape ID", () => {
    const response = (statusCode: number, scrapeId?: string) => ({
      success: true,
      data: { metadata: { statusCode, scrapeId } },
    });
    expect(
      hints({ endpoint: "scrape", response: response(401, "scrape-id") }).join(
        " ",
      ),
    ).toContain("POST /v2/scrape/scrape-id/interact");
    expect(
      hints({
        endpoint: "scrape",
        response: {
          success: true,
          scrape_id: "top-level-id",
          data: { metadata: { statusCode: 401 } },
        },
      }).join(" "),
    ).toContain("POST /v2/scrape/top-level-id/interact");
    expect(
      hints({
        endpoint: "scrape",
        response: {
          success: true,
          scrape_id: "top-level-id",
          data: {
            metadata: { statusCode: 401, scrapeId: "metadata-id" },
          },
        },
      }).join(" "),
    ).toContain("POST /v2/scrape/metadata-id/interact");
    expect(hints({ endpoint: "scrape", response: response(401) })).toEqual([]);
    expect(
      hints({ endpoint: "scrape", response: response(403, "scrape-id") }),
    ).toEqual([]);
  });

  it("suggests another scrape when a PDF result is truncated", () => {
    const response = (numPages: number, totalPages: number) => ({
      success: true,
      data: { metadata: { statusCode: 200, numPages, totalPages } },
    });
    const truncated = hints({
      endpoint: "scrape",
      response: response(5, 47),
    }).join(" ");
    expect(truncated).toContain("5 of 47 pages");
    expect(truncated).toContain('"maxPages":47');
    expect(
      hints({ endpoint: "scrape", response: response(5, 12000) }).join(" "),
    ).toContain('"maxPages":10000');
    expect(
      hints({ endpoint: "scrape", response: response(10000, 12000) }),
    ).toEqual([]);
    expect(hints({ endpoint: "scrape", response: response(47, 47) })).toEqual(
      [],
    );
  });

  it("does not add static feedback guidance to otherwise hint-free results", () => {
    expect(hints({ response: { success: true, data: {} } })).toEqual([]);
    expect(hints({ response: { success: false, error: "failed" } })).toEqual(
      [],
    );
  });

  it("asks the agent to notify the user when credits are low", () => {
    expect(hints({ remainingCredits: 99 })).toEqual([
      "The connected Firecrawl account is low on credits. Let the user know they should add more credits.",
    ]);
    expect(
      hints({
        response: { success: false, error: "Invalid request" },
        remainingCredits: 0,
      }),
    ).toEqual([
      "The connected Firecrawl account is low on credits. Let the user know they should add more credits.",
    ]);
    expect(hints({ remainingCredits: 100 })).toEqual([]);
    expect(hints({ remainingCredits: Infinity })).toEqual([]);
    expect(hints({})).toEqual([]);
  });

  it("keeps useful next-job guidance alongside the low-credit notice", () => {
    const result = hints({
      remainingCredits: 50,
      response: {
        success: true,
        data: { web: [{ url: "https://example.com", description: "excerpt" }] },
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("add more credits");
    expect(result[1]).toContain("POST /v2/scrape");
  });
});
