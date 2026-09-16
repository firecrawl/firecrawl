import { buildAgentHints, type AgentHintContext } from "./agent-hints";

const jobId = "0199412e-7590-7000-8000-000000000001";
const hints = (overrides: Partial<AgentHintContext>) =>
  buildAgentHints({
    endpoint: "search",
    response: { success: true, data: {} },
    ...overrides,
  });

describe("deterministic agent hints", () => {
  it("keeps empty search feedback actionable and does not assume a positive rating", () => {
    const result = hints({ feedbackJobId: jobId });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain(`"jobId":"${jobId}"`);
    expect(result[0]).toContain('"endpoint":"search"');
    expect(result[0]).toContain("good, partial, or bad");
    expect(result[0]).toContain("valuableSources");
    expect(result[0]).toContain("missingContent");
    expect(result[0]).not.toContain('"rating":"good"');
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

  it("does not suggest feedback for failed searches even if identity is supplied", () => {
    expect(
      hints({
        response: { success: false, error: "failed" },
        feedbackJobId: jobId,
      }),
    ).toEqual([]);
  });

  it.each(["scrape", "parse", "map"] as const)(
    "uses %s feedback identity and accepted substantive note",
    endpoint => {
      const result = hints({ endpoint, feedbackJobId: jobId });
      expect(result.join(" ")).toContain(`"endpoint":"${endpoint}"`);
      expect(result.join(" ")).toContain("note");
    },
  );
});
