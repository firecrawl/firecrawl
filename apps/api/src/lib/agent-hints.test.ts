import { buildAgentHints, type AgentHintContext } from "./agent-hints";

const hints = (overrides: Partial<AgentHintContext>) =>
  buildAgentHints({
    endpoint: "search",
    response: { success: true, data: {} },
    ...overrides,
  });

describe("deterministic agent hints", () => {
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

  it("does not add static feedback guidance to otherwise hint-free results", () => {
    expect(hints({ response: { success: true, data: { web: [] } } })).toEqual(
      [],
    );
    expect(hints({ response: { success: false, error: "failed" } })).toEqual(
      [],
    );
  });

  it("asks the agent to notify the user when credits are low", () => {
    expect(hints({ remainingCredits: 1000 })).toEqual([
      "The connected Firecrawl account is low on credits. Let the user know they should add more credits.",
    ]);
    expect(hints({ remainingCredits: 1001 })).toEqual([]);
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
    expect(result[0]).toContain("POST /v2/scrape");
    expect(result[1]).toContain("add more credits");
  });
});
