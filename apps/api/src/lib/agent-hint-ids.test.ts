import {
  AGENT_HINT_IDS,
  buildAgentHintRecords,
  buildAgentHints,
  type AgentHintContext,
} from "./agent-hints";

const records = (overrides: Partial<AgentHintContext>) =>
  buildAgentHintRecords({
    endpoint: "search",
    response: { success: true, data: {} },
    ...overrides,
  });

const ids = (overrides: Partial<AgentHintContext>) =>
  records(overrides).map(hint => hint.id);

describe("agent hint ids", () => {
  it("pins the published id of every rule", () => {
    // These strings are the analytics key. Changing one breaks every series
    // already recorded against it, so a failure here is never a test fix.
    expect(AGENT_HINT_IDS).toEqual({
      LOW_CREDITS: "low_credits",
      SEARCH_EXCERPT_ONLY: "search_excerpt_only",
      SEARCH_NO_WEB_RESULTS: "search_no_web_results",
      SEARCH_ORIGIN_CLUSTER: "search_origin_cluster",
      SCRAPE_INTERACTIVE_AUTH: "scrape_interactive_auth",
      SCRAPE_SOURCE_GONE: "scrape_source_gone",
      SCRAPE_PDF_TRUNCATED: "scrape_pdf_truncated",
    });
  });

  it("gives each rule a distinct id", () => {
    const values = Object.values(AGENT_HINT_IDS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("identifies an excerpt-only search result", () => {
    expect(
      ids({
        response: {
          success: true,
          data: { web: [{ url: "https://example.com/a" }] },
        },
      }),
    ).toEqual([AGENT_HINT_IDS.SEARCH_EXCERPT_ONLY]);
  });

  it("identifies an empty web result collection", () => {
    expect(ids({ response: { success: true, data: { web: [] } } })).toEqual([
      AGENT_HINT_IDS.SEARCH_NO_WEB_RESULTS,
    ]);
  });

  it("identifies a clustered search origin", () => {
    const web = [1, 2, 3, 4].map(n => ({
      url: `https://cluster.example/${n}`,
      markdown: "full",
    }));
    expect(
      ids({
        response: { success: true, data: { web } },
        canUseMapAndCrawl: true,
      }),
    ).toEqual([AGENT_HINT_IDS.SEARCH_ORIGIN_CLUSTER]);
  });

  it("identifies a dead source page", () => {
    expect(
      ids({
        endpoint: "scrape",
        response: {
          success: true,
          data: {
            metadata: { statusCode: 404, url: "https://example.com/gone" },
          },
        },
      }),
    ).toEqual([AGENT_HINT_IDS.SCRAPE_SOURCE_GONE]);
  });

  it("identifies an interactive 401 scrape", () => {
    expect(
      ids({
        endpoint: "scrape",
        canUseInteract: true,
        response: {
          success: true,
          data: { metadata: { statusCode: 401, scrapeId: "job-1" } },
        },
      }),
    ).toEqual([AGENT_HINT_IDS.SCRAPE_INTERACTIVE_AUTH]);
  });

  it("identifies a truncated PDF", () => {
    expect(
      ids({
        endpoint: "scrape",
        response: {
          success: true,
          data: { metadata: { numPages: 5, totalPages: 40 } },
        },
      }),
    ).toEqual([AGENT_HINT_IDS.SCRAPE_PDF_TRUNCATED]);
  });

  it("identifies the low-credit notice ahead of a suggestion", () => {
    expect(
      ids({
        remainingCredits: 3,
        response: { success: true, data: { web: [] } },
      }),
    ).toEqual([
      AGENT_HINT_IDS.LOW_CREDITS,
      AGENT_HINT_IDS.SEARCH_NO_WEB_RESULTS,
    ]);
  });

  it("keeps an id stable when the wording changes", () => {
    // The id comes from the rule, not the string, so a record is still keyed
    // correctly however the text is later edited.
    const hint = records({
      response: { success: true, data: { web: [] } },
    })[0];
    expect(hint.id).toBe(AGENT_HINT_IDS.SEARCH_NO_WEB_RESULTS);
    expect(hint.text).toEqual(expect.any(String));
  });

  it("returns exactly the wording the string builder returns", () => {
    const context: Partial<AgentHintContext> = {
      remainingCredits: 3,
      response: { success: true, data: { web: [] } },
    };
    expect(records(context).map(hint => hint.text)).toEqual(
      buildAgentHints({
        endpoint: "search",
        response: { success: true, data: {} },
        ...context,
      }),
    );
  });
});
