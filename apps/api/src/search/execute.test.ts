const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  searchDeveloperCategory: vi.fn(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
  searchExchangeCatalog: vi.fn(),
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
vi.mock("./exchange-source", () => ({
  searchExchangeCatalog: mocks.searchExchangeCatalog,
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

import { executeSearch } from "./execute";
import { trackSearchRequest } from "../lib/tracking";
import { searchRequestSchema } from "../controllers/v2/types";

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
    expect(result.developerResultsCount).toBe(1);
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
  });

  it("rejects developer combined with other categories at the schema", () => {
    const mixed = searchRequestSchema.safeParse({
      query: "retries",
      categories: ["developer", "github"],
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

describe("executeSearch exchange source", () => {
  const webResult = {
    url: "https://example.com/a",
    title: "A",
    description: "a",
    position: 1,
  };
  const capability = {
    provider: "financial-datasets",
    capability: "prices/latest",
    concept: "prices",
    cohorts: ["finance"],
    creditsCost: 1,
    similarity: 0.9,
  };

  function sources(types: string[]) {
    return {
      query: "latest stock price by ticker",
      limit: 10,
      sources: types.map(type => ({ type })),
      timeout: 1_000,
    } as any;
  }

  beforeEach(() => {
    mocks.search.mockResolvedValue({ web: [webResult] });
    mocks.searchExchangeCatalog.mockResolvedValue([capability]);
  });

  it("leaves a web-only search exactly as it was: upstream called with web, no catalogue call, no exchange key", async () => {
    const result = await executeSearch(sources(["web"]), context, logger);

    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0][0].type).toEqual(["web"]);
    expect(mocks.searchExchangeCatalog).not.toHaveBeenCalled();
    expect(result.response).toEqual({ web: [webResult] });
    expect(result.response).not.toHaveProperty("exchange");
    expect(result.totalResultsCount).toBe(1);
    expect(result.searchCredits).toBe(2);
  });

  it("keeps the exchange type away from the upstream when mixed with web, and adds the catalogue beside the web results", async () => {
    const result = await executeSearch(
      sources(["web", "exchange"]),
      context,
      logger,
    );

    expect(mocks.search.mock.calls[0][0].type).toEqual(["web"]);
    expect(mocks.searchExchangeCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "latest stock price by ticker",
        limit: 10,
        teamId: "team-1",
        requestId: "request-1",
      }),
      logger,
    );
    expect(result.response).toEqual({
      web: [webResult],
      exchange: [capability],
    });
    expect(result.totalResultsCount).toBe(1);
    expect(result.searchCredits).toBe(2);
  });

  it("runs no upstream search and bills nothing for an exchange-only search", async () => {
    const result = await executeSearch(sources(["exchange"]), context, logger);

    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.response).toEqual({ exchange: [capability] });
    expect(result.totalResultsCount).toBe(0);
    expect(result.searchCredits).toBe(0);
    expect(result.totalCredits).toBe(0);
  });

  it("omits the key rather than publishing an empty catalogue when the Exchange did not answer", async () => {
    mocks.searchExchangeCatalog.mockResolvedValue(null);

    const result = await executeSearch(
      sources(["web", "exchange"]),
      context,
      logger,
    );

    expect(result.response).toEqual({ web: [webResult] });
    expect(result.response).not.toHaveProperty("exchange");
  });

  it("records every requested source in tracking, exchange included", async () => {
    await executeSearch(sources(["web", "exchange"]), context, logger);
    expect(vi.mocked(trackSearchRequest).mock.calls.at(-1)![0].sources).toEqual(
      ["web", "exchange"],
    );

    await executeSearch(sources(["exchange"]), context, logger);
    expect(vi.mocked(trackSearchRequest).mock.calls.at(-1)![0].sources).toEqual(
      ["exchange"],
    );
  });

  it("caps the catalogue wait at the caller's timeout", async () => {
    await executeSearch(
      { ...sources(["exchange"]), timeout: 2_500 },
      context,
      logger,
    );
    expect(mocks.searchExchangeCatalog.mock.calls[0][0].timeoutMs).toBe(2_500);
  });

  it("still passes news and images through to the upstream untouched", async () => {
    mocks.search.mockResolvedValue({ web: [webResult], news: [], images: [] });

    await executeSearch(
      sources(["web", "news", "images", "exchange"]),
      context,
      logger,
    );

    expect(mocks.search.mock.calls[0][0].type).toEqual([
      "web",
      "news",
      "images",
    ]);
  });
});
