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
      canUseMapAndCrawl: true,
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
        canUseMapAndCrawl: false,
        response: {
          success: true,
          data: {
            web: [
              { url: "https://docs.example.com/a", markdown: "a" },
              { url: "https://docs.example.com/b", markdown: "b" },
              { url: "https://docs.example.com/c", markdown: "c" },
              { url: "https://other.example.com/d", markdown: "d" },
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

  it("names the excerpt-only results by position and URL", () => {
    const [hint] = hints({
      response: {
        success: true,
        data: {
          web: [
            { url: "https://a.example/full", markdown: "full" },
            { url: "https://b.example/one", description: "excerpt" },
            { url: "https://c.example/two", description: "excerpt" },
          ],
        },
      },
    });
    expect(hint).toContain("2 of 3 web results are excerpts only");
    expect(hint).toContain(
      "#2 https://b.example/one, #3 https://c.example/two",
    );
    expect(hint).not.toContain("https://a.example/full");
    expect(hint).toContain("do not re-scrape");
  });

  it("caps the listed excerpt URLs and counts the rest", () => {
    const web = [1, 2, 3, 4, 5].map(n => ({ url: `https://e.example/${n}` }));
    const [hint] = hints({ response: { success: true, data: { web } } });
    expect(hint).toContain("All 5 web results are excerpts only");
    expect(hint).toContain("#3 https://e.example/3 and 2 more");
    expect(hint).not.toContain("https://e.example/4");
  });

  it("prefills a site-scoped search from the dead URL path", () => {
    const [hint] = hints({
      endpoint: "scrape",
      response: {
        success: true,
        data: {
          metadata: {
            statusCode: 404,
            sourceURL:
              "https://docs.stripe.com/payments/checkout/migration-from-legacy",
            url: "https://docs.stripe.com/payments/checkout/migration-from-legacy",
          },
        },
      },
    });
    expect(hint).toContain("returned 404.");
    expect(hint).toContain(
      '"query":"site:docs.stripe.com checkout migration from legacy"',
    );
    expect(hint).not.toContain("redirecting");
  });

  it("names the redirect when the dead page was reached through one", () => {
    const [hint] = hints({
      endpoint: "scrape",
      response: {
        success: true,
        data: {
          metadata: {
            statusCode: 410,
            sourceURL:
              "https://www.service-public.fr/particuliers/vosdroits/F1234",
            url: "https://www.service-public.gouv.fr/particuliers/vosdroits/F1234",
          },
        },
      },
    });
    expect(hint).toContain(
      "returned 410 after redirecting from https://www.service-public.fr/particuliers/vosdroits/F1234 to https://www.service-public.gouv.fr/particuliers/vosdroits/F1234",
    );
    expect(hint).toContain(
      '"query":"site:www.service-public.gouv.fr vosdroits F1234"',
    );
  });

  it("drops file extensions and opaque ids from the prefilled query", () => {
    const [hint] = hints({
      endpoint: "scrape",
      response: {
        success: true,
        data: {
          metadata: {
            statusCode: 404,
            url: "https://github.com/org/repo/blob/main/store/base.py",
          },
        },
      },
    });
    expect(hint).toContain('"query":"site:github.com store base"');
    const [opaque] = hints({
      endpoint: "scrape",
      response: {
        success: true,
        data: {
          metadata: {
            statusCode: 404,
            url: "https://x.example/posts/12345/9f8e7d6c5b4a39281706f5e4",
          },
        },
      },
    });
    expect(opaque).toContain('"query":"site:x.example posts"');
  });

  it("falls back to a placeholder query without a usable URL", () => {
    const [hint] = hints({
      endpoint: "scrape",
      response: { success: true, data: { metadata: { statusCode: 404 } } },
    });
    expect(hint).toContain('"query":"<page name or subject>"');
  });

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
      hints({
        endpoint: "scrape",
        canUseInteract: true,
        response: response(401, "scrape-id"),
      }).join(" "),
    ).toContain("POST /v2/scrape/scrape-id/interact");
    expect(
      hints({
        endpoint: "scrape",
        canUseInteract: true,
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
        canUseInteract: true,
        response: {
          success: true,
          scrape_id: "top-level-id",
          data: {
            metadata: { statusCode: 401, scrapeId: "metadata-id" },
          },
        },
      }).join(" "),
    ).toContain("POST /v2/scrape/metadata-id/interact");
    expect(
      hints({
        endpoint: "scrape",
        canUseInteract: false,
        response: response(401, "scrape-id"),
      }),
    ).toEqual([]);
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
