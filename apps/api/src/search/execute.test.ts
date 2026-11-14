const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  searchDeveloperCategory: vi.fn(),
  searchGovCategory: vi.fn(),
  searchGovIfRouted: vi.fn(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
  discoverTools: vi.fn(),
  discoverSkills: vi.fn(),
  removeExplicitResults: vi.fn(),
  inferToolIntent: vi.fn(),
  verifyTools: vi.fn(),
}));

vi.mock("./tool-intent", () => ({
  AUTO_TOOLS_WAIT_MS: 300,
  FUSED_FIT_THRESHOLD: 0.2,
  inferToolIntent: mocks.inferToolIntent,
  verifyTools: mocks.verifyTools,
}));

vi.mock("./alexandria", () => ({
  discoverTools: mocks.discoverTools,
  usOnlyToolsWarning: (excluded: number) => `${excluded} tools hidden`,
  isAlexandriaSource: (source: { type: string }) =>
    source.type === "alexandria",
}));

vi.mock("./skill-cards", () => ({
  discoverSkills: mocks.discoverSkills,
  isSkillsSource: (source: { type: string }) => source.type === "skills",
  SKILLS_DISCOVERY_TIMEOUT_MS: 3000,
}));

vi.mock("./v2", () => ({ search: mocks.search }));
vi.mock("./developer", () => ({
  wantsDeveloperCategory: (categories?: Array<string | { type: string }>) =>
    (categories ?? []).some(category =>
      typeof category === "string"
        ? category === "developer"
        : category.type === "developer",
    ),
  searchDeveloperCategory: mocks.searchDeveloperCategory,
}));
vi.mock("./gov", () => ({
  wantsGovCategory: (categories?: Array<string | { type: string }>) =>
    (categories ?? []).some(category =>
      typeof category === "string"
        ? category === "gov"
        : category.type === "gov",
    ),
  searchGovCategory: mocks.searchGovCategory,
  searchGovIfRouted: mocks.searchGovIfRouted,
  MAX_ROUTED_LIMIT: 10,
}));
vi.mock("./scrape", () => ({
  getItemsToScrape: vi.fn(() => []),
  scrapeSearchResults: vi.fn(),
  mergeScrapedContent: vi.fn(),
  calculateScrapeCredits: vi.fn(() => 0),
}));
vi.mock("./highlights", () => ({
  highlightsEnvReady: () => false,
  runIndexedSearchHighlights: vi.fn(),
  searchHighlightsMode: vi.fn(),
}));
vi.mock("../lib/tracking", () => ({
  trackSearchRequest: vi.fn(async () => {}),
  trackSearchResults: vi.fn(async () => {}),
}));
vi.mock("../lib/threat-protection/request", () => ({
  checkUrlsAgainstThreatPolicy: mocks.checkUrlsAgainstThreatPolicy,
}));
vi.mock("../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(() => 0),
}));
vi.mock("./safe-search", () => ({
  removeExplicitResults: mocks.removeExplicitResults,
}));

import { executeSearch } from "./execute";
import { searchRequestSchema } from "../controllers/v2/types";
import { logger as rootLogger } from "../lib/logger";

const impressions = vi
  .spyOn(rootLogger, "info")
  .mockImplementation(() => rootLogger);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const context = {
  teamId: "team-1",
  origin: "api",
  apiKeyId: 1,
  flags: {},
  requestId: "request-1",
  jobId: "job-1",
  apiVersion: "v2",
};

// searchDeveloperCategory returns the exact WebSearchResult shape.
const developerResult = {
  url: "https://github.com/firecrawl/firecrawl/issues/1",
  title: "Retry requests",
  description: "Use exponential backoff.",
  position: 1,
  category: "developer",
};

function options(categories: Array<{ type: string }>) {
  return {
    query: "retries",
    limit: 10,
    sources: [{ type: "web" }],
    categories,
    timeout: 1_000,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchDeveloperCategory.mockResolvedValue([developerResult]);
  mocks.searchGovIfRouted.mockResolvedValue(null);
  mocks.discoverTools.mockResolvedValue({
    status: "available",
    items: [{ id: "fred/series/observations" }],
  });
  mocks.discoverSkills.mockResolvedValue({ skills: [], succeeded: false });
  mocks.verifyTools.mockImplementation(async (_query, items) => items);
});

it("tool-only search never runs or bills SERP", async () => {
  const result = await executeSearch(
    { ...options([]), sources: [{ type: "alexandria" }] },
    { ...context, flags: { exchangeRetrieve: true } },
    logger,
  );
  expect(mocks.search).not.toHaveBeenCalled();
  expect(result.searchCredits).toBe(0);
  expect(result.response.tools).toEqual([{ id: "fred/series/observations" }]);
});

it("passes through unavailable tool discovery", async () => {
  mocks.discoverTools.mockResolvedValue({
    items: [],
    warning: "Some tool discovery results are unavailable.",
    unavailable: true,
  });
  const result = await executeSearch(
    { ...options([]), sources: [{ type: "alexandria" }] },
    { ...context, flags: { exchangeRetrieve: true } },
    logger,
  );
  expect(result.toolsUnavailable).toBe(true);
  expect(result.response.tools).toEqual([]);
});

it("mixed search bills only normal web results", async () => {
  mocks.search.mockResolvedValue({ web: [developerResult] });
  const result = await executeSearch(
    { ...options([]), sources: [{ type: "web" }, { type: "alexandria" }] },
    { ...context, flags: { exchangeRetrieve: true } },
    logger,
  );
  expect(mocks.search).toHaveBeenCalledWith(
    expect.objectContaining({ type: ["web"] }),
  );
  expect(result.searchCredits).toBe(2);
  expect(result.response.tools).toHaveLength(1);
});

describe("executeSearch tool intent", () => {
  const webResult = {
    url: "https://example.com/",
    title: "Example",
    description: "An example page.",
  };

  it("keeps the raw query and adds verified rewrite and domain tools", async () => {
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["institutional holders of a public company"],
      domains: ["sec.gov"],
      needsTools: true,
    });
    await executeSearch(
      {
        ...options([]),
        query: "who owns apple stock",
        sources: [{ type: "alexandria" }],
        inferToolQuery: true,
      },
      context,
      logger,
    );
    expect(mocks.discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({ queries: ["who owns apple stock"] }),
      logger,
    );
    expect(mocks.discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({
        queries: ["institutional holders of a public company"],
        urls: ["https://sec.gov/"],
      }),
      logger,
    );
    expect(mocks.verifyTools).toHaveBeenCalledWith(
      "who owns apple stock",
      [{ id: "fred/series/observations" }],
      logger,
    );
  });

  it("adds no tool the fit check rejects", async () => {
    const own = { provider: "sec-gov", capability: "filings/filings" };
    const extra = { provider: "apps-apple-com", capability: "apps/app" };
    mocks.discoverTools.mockImplementation(
      async (input: { queries?: string[] }) => ({
        items: input.queries?.[0] === "who owns apple stock" ? [own] : [extra],
      }),
    );
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["institutional holders of a public company"],
      domains: [],
      needsTools: true,
    });
    mocks.verifyTools.mockResolvedValue([]);
    const result = await executeSearch(
      {
        ...options([]),
        query: "who owns apple stock",
        sources: [{ type: "alexandria" }],
        inferToolQuery: true,
      },
      context,
      logger,
    );
    expect(result.response.tools).toEqual([own]);
  });

  it("adds tools to a default search when the query needs them", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["US unemployment rate statistics"],
      domains: [],
      needsTools: true,
    });
    const result = await executeSearch(
      { ...options([]), autoTools: true },
      context,
      logger,
    );
    expect(mocks.discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({
        toolDetail: "compact",
        queries: ["retries", "US unemployment rate statistics"],
        urls: [],
      }),
      logger,
    );
    expect(result.toolsAuto).toBe(true);
    expect(result.response.tools).toEqual([{ id: "fred/series/observations" }]);
    expect(result.searchCredits).toBe(2);
  });

  it("warns a US-only team about tools hidden from automatic discovery", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["US unemployment rate statistics"],
      domains: [],
      needsTools: true,
    });
    mocks.discoverTools.mockResolvedValue({
      items: [{ id: "fred/series/observations" }],
      usOnlyExcluded: 2,
    });
    const result = await executeSearch(
      { ...options([]), autoTools: true },
      { ...context, flags: { usOnly: true } },
      logger,
    );
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ usOnly: true }),
    );
    expect(mocks.discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({ usOnly: true }),
      logger,
    );
    expect(result.toolsWarning).toBe("2 tools hidden");
  });

  it.each([
    [{ scrapeZDR: "forced" }, true],
    [{ forceZDR: true }, true],
    [{ scrapeZDR: "allowed" }, false],
    [{}, false],
  ])(
    "asks tool and skill discovery for zero-data-retention providers by team flags (%o)",
    async (flags, zeroDataRetention) => {
      mocks.search.mockResolvedValue({ web: [webResult] });
      mocks.discoverTools.mockResolvedValue({ items: [] });
      await executeSearch(
        {
          ...options([]),
          sources: [
            { type: "web" },
            { type: "alexandria" },
            { type: "skills" },
          ],
        },
        { ...context, flags } as any,
        logger,
      );
      expect(mocks.discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({ zeroDataRetention }),
        logger,
      );
      expect(mocks.discoverSkills).toHaveBeenCalledWith(
        expect.objectContaining({ zeroDataRetention }),
        logger,
      );
    },
  );

  it("leaves a default search alone when the query does not need tools", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["CSS layout documentation"],
      domains: [],
      needsTools: false,
    });
    const result = await executeSearch(
      { ...options([]), autoTools: true },
      context,
      logger,
    );
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(result.toolsAuto).toBe(false);
    expect(result.response.tools).toBeUndefined();
  });

  it("adds query tools beside domain tools when domainTools is on", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["website traffic statistics of a domain"],
      domains: [],
      needsTools: true,
    });
    await executeSearch(
      { ...options([]), autoTools: true, domainTools: true },
      context,
      logger,
    );
    expect(mocks.discoverTools).toHaveBeenCalledTimes(2);
    const domainCall = mocks.discoverTools.mock.calls.find(
      ([input]) => input.urls instanceof Promise,
    );
    await expect(domainCall?.[0].urls).resolves.toEqual([
      "https://example.com/",
    ]);
    expect(mocks.discoverTools).toHaveBeenCalledWith(
      expect.objectContaining({
        queries: ["retries", "website traffic statistics of a domain"],
        urls: [],
      }),
      logger,
    );
  });

  it("waits at most 300ms past the web results for tools it did not ask for", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.inferToolIntent.mockResolvedValue({
      toolQueries: ["US unemployment rate statistics"],
      domains: [],
      needsTools: true,
    });
    mocks.discoverTools.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      let done = false;
      const pending = executeSearch(
        { ...options([]), autoTools: true },
        context,
        logger,
      ).finally(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.response.tools).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("with tool fusion", () => {
    const tool = (provider: string) => ({ provider, capability: "data/get" });
    const intent = {
      toolQueries: ["institutional holders of a public company"],
      domains: [],
      needsTools: true,
    };
    const fused = (query: string) =>
      executeSearch(
        {
          ...options([]),
          query,
          sources: [{ type: "alexandria" }],
          inferToolQuery: true,
          toolFusion: true,
        },
        context,
        logger,
      );

    it("ranks rewrite tools among raw-query tools by reciprocal rank", async () => {
      mocks.inferToolIntent.mockResolvedValue(intent);
      mocks.discoverTools.mockImplementation(
        async (input: { queries?: string[] }) =>
          input.queries?.[0] === "who owns apple stock"
            ? {
                items: [tool("a"), tool("b"), tool("c"), tool("domain")],
                semanticMatches: 3,
              }
            : {
                items: [tool("x"), tool("c"), tool("y"), tool("site")],
                semanticMatches: 3,
              },
      );
      const result = await fused("who owns apple stock");
      expect(result.response.tools?.map(found => found.provider)).toEqual([
        "c",
        "a",
        "x",
        "b",
        "y",
        "domain",
        "site",
      ]);
      expect(mocks.verifyTools).toHaveBeenCalledWith(
        "who owns apple stock",
        [tool("x"), tool("c"), tool("y")],
        logger,
        0.2,
      );
      expect(mocks.verifyTools).toHaveBeenCalledWith(
        "who owns apple stock",
        [tool("site")],
        logger,
      );
    });

    it("logs the served tools with their rank, source and fit rejections", async () => {
      mocks.inferToolIntent.mockResolvedValue(intent);
      mocks.discoverTools.mockImplementation(
        async (input: {
          queries?: string[];
          exchangeRequestIds?: { prefix: string; sent: string[] };
        }) => {
          input.exchangeRequestIds?.sent.push(
            `${input.exchangeRequestIds.prefix}:1`,
          );
          return input.queries?.[0] === "who owns apple stock"
            ? {
                items: [tool("a"), tool("b"), tool("c"), tool("domain")],
                semanticMatches: 3,
              }
            : {
                items: [tool("x"), tool("c"), tool("y"), tool("site")],
                semanticMatches: 3,
              };
        },
      );
      mocks.verifyTools.mockImplementation(async (_query, items) =>
        items.filter(
          (item: { provider: string }) =>
            item.provider !== "y" && item.provider !== "site",
        ),
      );
      const result = await fused("who owns apple stock");
      expect(result.toolFusion).toBe(true);
      expect(mocks.discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRequestIds: expect.objectContaining({
            prefix: "job-1:tools:raw",
          }),
        }),
        logger,
      );
      expect(mocks.discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRequestIds: expect.objectContaining({
            prefix: "job-1:tools:rewrite",
          }),
        }),
        logger,
      );
      expect(impressions).toHaveBeenCalledWith("Search tool impression", {
        event: "search_tool_impression",
        searchId: "job-1",
        teamId: "team-1",
        servedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        auto: false,
        fusion: { enabled: true, ran: true },
        rewrite: "arrived",
        tools: [
          { id: "c/data/get", rank: 1, source: "both" },
          { id: "a/data/get", rank: 2, source: "raw" },
          { id: "x/data/get", rank: 3, source: "rewrite" },
          { id: "b/data/get", rank: 4, source: "raw" },
          { id: "domain/data/get", rank: 5, source: "raw" },
        ],
        fitRejected: { semantic: 1, domain: 1 },
        exchangeRequestIds: {
          raw: ["job-1:tools:raw:1"],
          rewrite: ["job-1:tools:rewrite:1"],
        },
      });
      expect(JSON.stringify(impressions.mock.calls)).not.toContain(
        "who owns apple stock",
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        "Search tool impression",
        expect.anything(),
      );
    });

    it("reports no fusion when the rewrite found no tools", async () => {
      mocks.inferToolIntent.mockResolvedValue(intent);
      mocks.discoverTools.mockImplementation(
        async (input: { queries?: string[] }) =>
          input.queries?.[0] === "who owns apple stock"
            ? { items: [tool("a")], semanticMatches: 1 }
            : { items: [], semanticMatches: 0 },
      );
      const result = await fused("who owns apple stock");
      expect(result.toolFusion).toBe(false);
      expect(impressions).toHaveBeenCalledWith(
        "Search tool impression",
        expect.objectContaining({
          fusion: { enabled: true, ran: false },
          rewrite: "empty",
        }),
      );
    });

    it("drops rewrite-only tools the fit check rejects", async () => {
      mocks.inferToolIntent.mockResolvedValue(intent);
      mocks.discoverTools.mockImplementation(
        async (input: { queries?: string[] }) =>
          input.queries?.[0] === "who owns apple stock"
            ? { items: [tool("a"), tool("b")], semanticMatches: 2 }
            : { items: [tool("x"), tool("b")], semanticMatches: 2 },
      );
      mocks.verifyTools.mockResolvedValue([]);
      const result = await fused("who owns apple stock");
      expect(result.response.tools?.map(found => found.provider)).toEqual([
        "b",
        "a",
      ]);
    });

    it("scores rewrite tools by their original rank when earlier ones are rejected", async () => {
      mocks.inferToolIntent.mockResolvedValue(intent);
      mocks.discoverTools.mockImplementation(
        async (input: { queries?: string[] }) =>
          input.queries?.[0] === "who owns apple stock"
            ? { items: [tool("a"), tool("b")], semanticMatches: 2 }
            : { items: [tool("x"), tool("y")], semanticMatches: 2 },
      );
      mocks.verifyTools.mockImplementation(async (_query, items) =>
        items.filter((item: { provider: string }) => item.provider !== "x"),
      );
      const result = await fused("who owns apple stock");
      expect(result.response.tools?.map(found => found.provider)).toEqual([
        "a",
        "b",
        "y",
      ]);
    });

    it("waits up to the configured cap past the raw lookup for rewrite tools", async () => {
      mocks.inferToolIntent.mockResolvedValue(intent);
      mocks.discoverTools.mockImplementation(
        (input: {
          queries?: string[];
          exchangeRequestIds?: { prefix: string; sent: string[] };
        }) => {
          input.exchangeRequestIds?.sent.push(
            `${input.exchangeRequestIds.prefix}:1`,
          );
          if (input.queries?.[0] === "who owns apple stock")
            return Promise.resolve({ items: [tool("a")], semanticMatches: 1 });
          return new Promise(() => {});
        },
      );
      vi.useFakeTimers();
      try {
        let done = false;
        const pending = fused("who owns apple stock").finally(() => {
          done = true;
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        expect(result.response.tools).toEqual([tool("a")]);
        expect(result.toolFusion).toBe(false);
        expect(impressions).toHaveBeenCalledWith(
          "Search tool impression",
          expect.objectContaining({
            fusion: { enabled: true, ran: false },
            rewrite: "late",
            tools: [{ id: "a/data/get", rank: 1, source: "raw" }],
            exchangeRequestIds: {
              raw: ["job-1:tools:raw:1"],
              rewrite: ["job-1:tools:rewrite:1"],
            },
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("never adds tools under zero data retention", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    await executeSearch(
      { ...options([]), autoTools: true },
      { ...context, zeroDataRetention: true },
      logger,
    );
    expect(mocks.inferToolIntent).not.toHaveBeenCalled();
    expect(mocks.discoverTools).not.toHaveBeenCalled();
    expect(impressions).not.toHaveBeenCalledWith(
      "Search tool impression",
      expect.anything(),
    );
  });
});

describe("executeSearch safe search", () => {
  const webResult = {
    url: "https://example.com/",
    title: "Example",
    description: "An example page.",
  };

  it("bills and returns only the results the Jev filter keeps", async () => {
    const safe = Array.from({ length: 10 }, (_, index) => ({
      ...webResult,
      url: `https://safe${index}.example/`,
    }));
    const explicit = { ...webResult, url: "https://nsfw.example/" };
    mocks.search.mockResolvedValue({ web: [...safe, explicit] });
    mocks.removeExplicitResults.mockImplementationOnce(async response => {
      response.web = response.web.filter(
        (result: { url: string }) => result.url !== explicit.url,
      );
    });

    const result = await executeSearch(
      { ...options([]), limit: 20, safe: true },
      context,
      logger,
    );

    expect(mocks.removeExplicitResults).toHaveBeenCalledWith(
      expect.anything(),
      20,
      logger,
      "team-1",
    );
    expect(result.response.web?.map(x => x.url)).toEqual(safe.map(x => x.url));
    expect(result.totalResultsCount).toBe(10);
    // 11 results would bill 4 credits; the 10 kept bill 2.
    expect(result.searchCredits).toBe(2);
  });

  it("skips the Jev filter when safe is off or data must not be retained", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });

    await executeSearch(options([]), context, logger);
    await executeSearch(
      { ...options([]), safe: true },
      { ...context, zeroDataRetention: true },
      logger,
    );
    await executeSearch(
      { ...options([]), safe: true, enterprise: ["zdr"] },
      context,
      logger,
    );
    await executeSearch(
      { ...options([]), safe: true, enterprise: ["anon"] },
      context,
      logger,
    );

    expect(mocks.removeExplicitResults).not.toHaveBeenCalled();
  });
});

describe("executeSearch zero data retention rate", () => {
  const results = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      url: `https://result${index}.example/`,
      title: "Result",
      description: "A result.",
    }));

  it.each([
    { name: "a default search", enterprise: undefined, ten: 2, eleven: 4 },
    {
      name: "an enterprise anon search",
      enterprise: ["anon"],
      ten: 2,
      eleven: 4,
    },
    {
      name: "an enterprise zdr search",
      enterprise: ["zdr"],
      ten: 10,
      eleven: 20,
    },
  ])("bills $name per ten results", async ({ enterprise, ten, eleven }) => {
    for (const [count, credits] of [
      [10, ten],
      [11, eleven],
    ]) {
      mocks.search.mockResolvedValue({ web: results(count) });
      const result = await executeSearch(
        { ...options([]), limit: 20, enterprise },
        context,
        logger,
      );
      expect(result.searchCredits).toBe(credits);
    }
  });
});

describe("executeSearch developer category", () => {
  it("returns sole developer-category results in web without running SERP", async () => {
    const result = await executeSearch(
      options([{ type: "developer" }]),
      context,
      logger,
    );

    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.response).toEqual({ web: [developerResult] });
    expect(result.response).not.toHaveProperty("developer");
    expect(result.indexResultsCount).toBe(1);
    // The vertical that served the result survives the response as a label
    // keyed by the position the client sees.
    expect(result.resultCategories).toEqual({ web: { "1": "developer" } });
  });

  it("filters blocked developer results via threat protection and renumbers", async () => {
    mocks.searchDeveloperCategory.mockResolvedValue([
      {
        url: "https://ok.example/a",
        title: "A",
        description: "",
        position: 1,
        category: "developer",
      },
      {
        url: "https://blocked.example/b",
        title: "B",
        description: "",
        position: 2,
        category: "developer",
      },
      {
        url: "https://ok.example/c",
        title: "C",
        description: "",
        position: 3,
        category: "developer",
      },
    ]);
    mocks.checkUrlsAgainstThreatPolicy.mockResolvedValue({
      decisionsByUrl: new Map([
        ["https://blocked.example/b", { allowed: false }],
      ]),
    });

    const result = await executeSearch(
      options([{ type: "developer" }]),
      { ...context, threatProtectionPolicy: { mode: "block" } } as any,
      logger,
    );

    expect(mocks.checkUrlsAgainstThreatPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.search).not.toHaveBeenCalled();
    expect((result.response.web ?? []).map(x => [x.url, x.position])).toEqual([
      ["https://ok.example/a", 1],
      ["https://ok.example/c", 2],
    ]);
    // Keyed by the renumbered positions, not the upstream ones — position 2 is
    // the surviving third result.
    expect(result.resultCategories).toEqual({
      web: { "1": "developer", "2": "developer" },
    });
  });

  it("returns an empty group and no categories when every result is blocked", async () => {
    mocks.searchDeveloperCategory.mockResolvedValue([
      {
        url: "https://blocked.example/a",
        title: "A",
        description: "",
        position: 1,
        category: "developer",
      },
      {
        url: "https://blocked.example/b",
        title: "B",
        description: "",
        position: 2,
        category: "developer",
      },
    ]);
    mocks.checkUrlsAgainstThreatPolicy.mockResolvedValue({
      decisionsByUrl: new Map([
        ["https://blocked.example/a", { allowed: false }],
        ["https://blocked.example/b", { allowed: false }],
      ]),
    });

    const result = await executeSearch(
      options([{ type: "developer" }]),
      { ...context, threatProtectionPolicy: { mode: "block" } } as any,
      logger,
    );

    expect(result.response.web ?? []).toEqual([]);
    // An empty map, not absent: the search ran and tagged nothing, which
    // feedback must tell apart from a row that predates the column.
    expect(result.resultCategories).toEqual({});
  });

  it.each([
    {
      name: "a forced team",
      context: { zeroDataRetention: true },
      enterprise: [],
    },
    { name: "an enterprise zdr request", context: {}, enterprise: ["zdr"] },
    { name: "an enterprise anon request", context: {}, enterprise: ["anon"] },
  ])(
    "marks the developer upstream call zero data retention for $name",
    async c => {
      await executeSearch(
        {
          ...options([{ type: "developer" }]),
          enterprise: c.enterprise,
        } as any,
        { ...context, ...c.context } as any,
        logger,
      );

      expect(mocks.searchDeveloperCategory).toHaveBeenCalledWith(
        expect.objectContaining({ zeroDataRetention: true }),
        logger,
      );
    },
  );

  it("rejects developer combined with other categories at the schema", () => {
    const mixed = searchRequestSchema.safeParse({
      query: "retries",
      categories: ["developer", "pdf"],
    });
    expect(mixed.success).toBe(false);
    if (!mixed.success) {
      expect(JSON.stringify(mixed.error.issues)).toContain(
        "cannot be combined",
      );
    }

    const sole = searchRequestSchema.safeParse({
      query: "retries",
      categories: ["developer"],
    });
    expect(sole.success).toBe(true);
  });
});

describe("executeSearch gov category", () => {
  const govResult = {
    url: "https://www.ecfr.gov/current/title-21/part-101",
    title: "21 CFR Part 101",
    description: "Food labeling",
    position: 1,
    category: "gov",
  };

  it("returns sole gov-category results in web without running SERP", async () => {
    mocks.searchGovCategory.mockResolvedValue([govResult]);

    const result = await executeSearch(
      options([{ type: "gov" }]),
      context,
      logger,
    );

    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.searchDeveloperCategory).not.toHaveBeenCalled();
    expect(mocks.searchGovCategory).toHaveBeenCalledWith(
      {
        query: "retries",
        limit: 10,
        teamId: "team-1",
        timeout: 1_000,
        zeroDataRetention: false,
      },
      logger,
    );
    expect(result.response).toEqual({ web: [govResult] });
    expect(result.indexResultsCount).toBe(1);
    expect(result.searchCredits).toBe(0);
  });
});

describe("executeSearch gov routing", () => {
  const govResult = {
    url: "https://www.dol.gov/agencies/whd/fmla",
    title: "FMLA",
    description: "Family and Medical Leave Act",
    position: 1,
  };
  const webResult = {
    url: "https://example.com/",
    title: "Example",
    description: "",
  };

  it("serves a routed plain web search from the Government Index, skips the regular web search, and bills it as a web search", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.searchGovIfRouted.mockResolvedValue([govResult]);

    const result = await executeSearch(options([]), context, logger);

    expect(mocks.searchGovIfRouted).toHaveBeenCalledWith(
      {
        query: "retries",
        limit: 10,
        teamId: "team-1",
        timeout: 1_000,
        zeroDataRetention: false,
      },
      "job-1",
      logger,
    );
    expect(mocks.searchGovCategory).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.response).toEqual({ web: [govResult] });
    expect(result.searchCredits).toBe(2);
  });

  it("starts the regular web search only after the routing decision and serves it when the search is not routed", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    let webSearchCallsWhenRouting = -1;
    mocks.searchGovIfRouted.mockImplementation(async () => {
      webSearchCallsWhenRouting = mocks.search.mock.calls.length;
      return null;
    });

    const result = await executeSearch(options([]), context, logger);

    expect(webSearchCallsWhenRouting).toBe(0);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(result.response.web?.map(item => item.url)).toEqual([
      "https://example.com/",
    ]);
  });

  it.each([
    ["a category", { categories: [{ type: "pdf" }] }],
    ["another source", { sources: [{ type: "web" }, { type: "news" }] }],
    ["included domains", { includeDomains: ["example.com"] }],
    ["excluded domains", { excludeDomains: ["example.com"] }],
    ["a time range", { tbs: "qdr:d" }],
    ["a result filter", { filter: "0" }],
    ["a country other than the US", { country: "gb" }],
    ["a site: operator", { query: "leave site:dol.gov" }],
    [
      "an operator the parser leaves in the text",
      { query: "fmla filetype:pdf" },
    ],
    ["an OR between terms", { query: "fmla OR overtime" }],
    ["a quoted phrase", { query: '"family leave" eligibility' }],
    ["a language other than English", { lang: "es" }],
    ["a location", { location: "Toronto, Ontario" }],
    ["a page larger than 10 results", { limit: 11 }],
    ["a blank query", { query: "   " }],
  ])("never routes a search with %s", async (_case, overrides) => {
    mocks.search.mockResolvedValue({ web: [] });

    await executeSearch({ ...options([]), ...overrides }, context, logger);

    expect(mocks.searchGovIfRouted).not.toHaveBeenCalled();
  });

  it.each([
    ["a zero data retention team", {}, { zeroDataRetention: true }],
    ["an enterprise zdr search", { enterprise: ["zdr"] }, {}],
    ["an enterprise anon search", { enterprise: ["anon"] }, {}],
  ])("never routes %s", async (_case, optionOverrides, contextOverrides) => {
    mocks.search.mockResolvedValue({ web: [] });

    await executeSearch(
      { ...options([]), ...optionOverrides },
      { ...context, ...contextOverrides } as any,
      logger,
    );

    expect(mocks.searchGovIfRouted).not.toHaveBeenCalled();
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it("never routes a US-only team", async () => {
    mocks.search.mockResolvedValue({ web: [] });

    await executeSearch(
      options([]),
      { ...context, flags: { usOnly: true } } as any,
      logger,
    );

    expect(mocks.searchGovIfRouted).not.toHaveBeenCalled();
  });
});

describe("executeSearch query operators", () => {
  const web = (url: string, title = "Result") => ({
    url,
    title,
    description: "",
  });
  const news = (url: string, title: string) => ({ url, title, snippet: "" });

  it("sends inurl: with site: as plain terms and enforces both on web results", async () => {
    mocks.search.mockResolvedValue({
      web: [
        web(
          "https://www.finance.example/2026/07/29/contoso-ctso-q4-earnings-report-2026.html",
        ),
        web("https://www.finance.example/quotes/CTSO"),
        web("https://www.stocks.example/stocks/xnas/ctso/earnings"),
        web(
          "https://www.finance.example/2026/04/29/contoso-ctso-q3-earnings-report-2026.html",
        ),
      ],
    });

    const result = await executeSearch(
      { ...options([]), query: "inurl:earnings Contoso site:finance.example" },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "earnings Contoso site:finance.example",
        includeDomains: ["finance.example"],
      }),
    );
    expect(result.response.web?.map(x => [x.position, x.url])).toEqual([
      [
        1,
        "https://www.finance.example/2026/07/29/contoso-ctso-q4-earnings-report-2026.html",
      ],
      [
        2,
        "https://www.finance.example/2026/04/29/contoso-ctso-q3-earnings-report-2026.html",
      ],
    ]);
  });

  it("bills nothing when the operators leave no results", async () => {
    mocks.search.mockResolvedValue({
      web: [web("https://www.finance.example/quotes/CTSO")],
    });

    const result = await executeSearch(
      { ...options([]), query: "inurl:earnings Contoso site:finance.example" },
      context,
      logger,
    );

    expect(result.response.web).toEqual([]);
    expect(result.totalResultsCount).toBe(0);
    expect(result.searchCredits).toBe(0);
  });

  it("applies both intitle: and site: to news results", async () => {
    mocks.search.mockResolvedValue({
      news: [
        news(
          "https://www.news.example/aktuell/wirtschaft/a.html",
          "Acme: Quarterly results - News",
        ),
        news(
          "https://www.forum.example/r/insurance/comments/1/acme/",
          "Acme denied claim",
        ),
        news(
          "https://www.news.example/agenturmeldungen/dpa/b.html",
          "Local team wins again - News",
        ),
      ],
    });

    const result = await executeSearch(
      {
        ...options([]),
        query: '"Acme" intitle:Acme site:news.example',
        sources: [{ type: "news" }],
        tbs: "qdr:w",
      },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: '"Acme" Acme site:news.example',
        includeDomains: ["news.example"],
        tbs: "qdr:w",
      }),
    );
    expect(result.response.news?.map(x => x.url)).toEqual([
      "https://www.news.example/aktuell/wirtschaft/a.html",
    ]);
  });

  it("enforces site: alone on news results", async () => {
    mocks.search.mockResolvedValue({
      news: [
        news("https://www.news.example/aktuell/a.html", "A"),
        news("https://www.acmecare.example/en/blog.html", "B"),
      ],
    });

    const result = await executeSearch(
      {
        ...options([]),
        query: "Acme site:news.example",
        sources: [{ type: "news" }],
      },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Acme site:news.example" }),
    );
    expect(result.response.news?.map(x => x.url)).toEqual([
      "https://www.news.example/aktuell/a.html",
    ]);
  });

  it("enforces site: on image results", async () => {
    mocks.search.mockResolvedValue({
      images: [
        {
          url: "https://www.news.example/a.html",
          title: "A",
          imageUrl: "https://cdn.example/a.jpg",
        },
        {
          url: "https://other.example/b.html",
          title: "B",
          imageUrl: "https://cdn.example/b.jpg",
        },
      ],
    });

    const result = await executeSearch(
      {
        ...options([]),
        query: "Acme site:news.example",
        sources: [{ type: "images" }],
      },
      context,
      logger,
    );

    expect(result.response.images?.map(x => [x.position, x.url])).toEqual([
      [1, "https://www.news.example/a.html"],
    ]);
  });

  it("enforces site: on category index results", async () => {
    mocks.searchDeveloperCategory.mockResolvedValue([
      developerResult,
      { ...developerResult, url: "https://docs.example/retries", position: 2 },
    ]);

    const result = await executeSearch(
      {
        ...options([{ type: "developer" }]),
        query: "retries site:docs.example",
      },
      context,
      logger,
    );

    expect(result.response.web?.map(x => [x.position, x.url])).toEqual([
      [1, "https://docs.example/retries"],
    ]);
    expect(result.indexResultsCount).toBe(1);
  });

  it("asks the provider for more results when it enforces inurl: or intitle: itself", async () => {
    mocks.search.mockResolvedValue({ web: [] });

    await executeSearch(
      { ...options([]), query: "inurl:earnings Contoso site:finance.example" },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ num_results: 50 }),
    );
  });

  it("forwards a custom date range tbs to the web provider unchanged", async () => {
    mocks.search.mockResolvedValue({ web: [] });
    const tbs = "cdr:1,cd_min:1/1/2024,cd_max:1/31/2024";

    await executeSearch(
      { ...options([]), query: "Contoso earnings site:finance.example", tbs },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ tbs, type: ["web"] }),
    );
  });
});

describe("executeSearch skill cards", () => {
  const card = {
    id: "official/search",
    name: "Search",
    description: "Find records",
    source: "official" as const,
    similarity: 0.5,
  };

  it("leaves skills off when the source was not requested", async () => {
    mocks.search.mockResolvedValue({ web: [developerResult] });

    const result = await executeSearch(options([]), context, logger);

    expect(mocks.discoverSkills).not.toHaveBeenCalled();
    expect(result.response).not.toHaveProperty("skills");
    expect(result.searchCredits).toBe(2);
  });

  it("starts skill discovery before the web search and maps the cards", async () => {
    const order: string[] = [];
    let releaseSkills: (found: {
      skills: unknown[];
      succeeded: boolean;
    }) => void = () => {};
    mocks.discoverSkills.mockImplementation(
      () =>
        new Promise(resolve => {
          order.push("skills");
          releaseSkills = resolve;
        }),
    );
    mocks.search.mockImplementation(async () => {
      order.push("web");
      releaseSkills({ skills: [card], succeeded: true });
      return { web: [developerResult] };
    });

    const result = await executeSearch(
      {
        ...options([]),
        sources: [{ type: "web" }, { type: "skills" }],
      },
      context,
      logger,
    );

    expect(order).toEqual(["skills", "web"]);
    expect(mocks.discoverSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        query: "retries",
        timeoutMs: 1000,
        usOnly: false,
      }),
      logger,
    );
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ type: ["web"] }),
    );
    expect(result.response.skills).toEqual([card]);
    expect(result.skillsDiscovered).toBe(true);
    expect(result.response.web).toHaveLength(1);
    expect(result.searchCredits).toBe(2);
  });

  it("keeps web results and returns no cards when skill discovery fails", async () => {
    mocks.search.mockResolvedValue({ web: [developerResult] });
    mocks.discoverSkills.mockRejectedValue(new Error("timed out"));

    const result = await executeSearch(
      {
        ...options([]),
        sources: [{ type: "web" }, { type: "skills" }],
      },
      context,
      logger,
    );

    expect(result.response.web).toHaveLength(1);
    expect(result.response.skills).toEqual([]);
    expect(result.skillsDiscovered).toBe(false);
    expect(result.searchCredits).toBe(2);
  });

  it("does not run or bill web search for a skills-only request", async () => {
    mocks.discoverSkills.mockResolvedValue({
      skills: [card],
      succeeded: true,
    });

    const result = await executeSearch(
      { ...options([]), sources: [{ type: "skills" }] },
      context,
      logger,
    );

    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.response.skills).toEqual([card]);
    expect(result.skillsDiscovered).toBe(true);
    expect(result.searchCredits).toBe(0);
    expect(result.totalCredits).toBe(0);
  });

  it.each([
    ["zero data retention", { zeroDataRetention: true }, {}],
    ["zdr enterprise mode", {}, { enterprise: ["zdr"] }],
    ["anon enterprise mode", {}, { enterprise: ["anon"] }],
  ])(
    "skips skill discovery under %s",
    async (_label, contextOverrides, optionOverrides) => {
      mocks.search.mockResolvedValue({ web: [developerResult] });

      const result = await executeSearch(
        {
          ...options([]),
          sources: [{ type: "web" }, { type: "skills" }],
          ...optionOverrides,
        },
        { ...context, ...contextOverrides },
        logger,
      );

      expect(mocks.discoverSkills).not.toHaveBeenCalled();
      expect(result.response).not.toHaveProperty("skills");
      expect(result.skillsDiscovered).toBe(false);
    },
  );

  it("skips skill discovery when the query is empty", async () => {
    const result = await executeSearch(
      {
        ...options([]),
        query: "   ",
        sources: [{ type: "skills" }],
      },
      context,
      logger,
    );

    expect(mocks.discoverSkills).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.response).not.toHaveProperty("skills");
    expect(result.skillsDiscovered).toBe(false);
  });

  it("forwards a US-only team to skill discovery", async () => {
    mocks.discoverSkills.mockResolvedValue({ skills: [], succeeded: true });

    await executeSearch(
      { ...options([]), sources: [{ type: "skills" }] },
      { ...context, flags: { usOnly: true } },
      logger,
    );

    expect(mocks.discoverSkills).toHaveBeenCalledWith(
      expect.objectContaining({ usOnly: true }),
      logger,
    );
  });
});
