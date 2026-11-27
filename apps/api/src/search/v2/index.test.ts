const mocks = vi.hoisted(() => ({
  searxngSearch: vi.fn(),
  ddgSearch: vi.fn(),
}));

vi.mock("./searxng", () => ({ searxng_search: mocks.searxngSearch }));
vi.mock("./ddgsearch", () => ({ ddgSearch: mocks.ddgSearch }));

import { createLogger } from "winston";
import { config } from "../../config";
import type { SearchV2Response } from "../../lib/entities";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";
import type { SearchProvider } from "../../service";
import { createService, replaceService } from "../../service/service";
import { coreSearchProviders } from "../providers";
import { search } from "./index";

const logger = createLogger({ silent: true });
const loggerErrorSpy = vi.spyOn(logger, "error");

const result = (url: string) => ({ url, title: url, description: "" });

const originalSearxngEndpoint = config.SEARXNG_ENDPOINT;

function installSearchService(
  extensions: Array<{
    name: string;
    searchProviders?: ReadonlyArray<SearchProvider>;
  }> = [],
) {
  replaceService(
    createService(
      { modules: {}, extensions },
      {
        core: { name: "core", searchProviders: coreSearchProviders },
        logger: { error: vi.fn() },
      },
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  config.SEARXNG_ENDPOINT = undefined;
  mocks.ddgSearch.mockResolvedValue({});
  installSearchService();
});

afterEach(() => {
  replaceService(undefined);
  config.SEARXNG_ENDPOINT = originalSearxngEndpoint;
});

describe("domain filters on the SearXNG and DuckDuckGo results", () => {
  beforeEach(() => {
    config.SEARXNG_ENDPOINT = "http://searxng.test";
  });

  it("keeps only results on an included domain or its subdomains", async () => {
    mocks.searxngSearch.mockResolvedValue({
      web: [
        result("https://www.firecrawl.dev/pricing"),
        result("http:///go/v1/AbC123"),
        result("https://firecrawl.dev/"),
        result("https://notfirecrawl.dev/"),
        result("https://example.com/firecrawl.dev"),
      ],
    });

    const res = await search({
      query: "firecrawl site:firecrawl.dev",
      logger,
      includeDomains: ["firecrawl.dev"],
    });

    expect(res.web?.map(r => r.url)).toEqual([
      "https://www.firecrawl.dev/pricing",
      "https://firecrawl.dev/",
    ]);
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
  });

  it("drops results on an excluded domain or its subdomains", async () => {
    mocks.searxngSearch.mockResolvedValue({
      web: [
        result("https://docs.example.com/a"),
        result("https://firecrawl.dev/"),
        result("https://example.com/b"),
      ],
    });

    const res = await search({
      query: "firecrawl -site:example.com",
      logger,
      excludeDomains: ["example.com"],
    });

    expect(res.web?.map(r => r.url)).toEqual(["https://firecrawl.dev/"]);
  });

  it("falls back to DuckDuckGo when no SearXNG result is on an included domain", async () => {
    mocks.searxngSearch.mockResolvedValue({
      web: [result("https://example.com/")],
    });
    mocks.ddgSearch.mockResolvedValue({
      web: [result("https://example.org/"), result("https://firecrawl.dev/")],
    });

    const res = await search({
      query: "firecrawl site:firecrawl.dev",
      logger,
      includeDomains: ["firecrawl.dev"],
    });

    expect(res.web?.map(r => r.url)).toEqual(["https://firecrawl.dev/"]);
  });

  it("passes every result through when no domain filter is set", async () => {
    const web = [
      result("https://example.com/"),
      result("https://firecrawl.dev/"),
    ];
    mocks.searxngSearch.mockResolvedValue({ web });

    const res = await search({ query: "firecrawl", logger });

    expect(res.web).toEqual(web);
  });
});

describe("service.searchProviders dispatch in v2 search", () => {
  it("tries enabled providers in priority order and stops on the first non-null response", async () => {
    const highResult = {
      web: [{ url: "https://high.test", title: "High", description: "" }],
    };
    const lowResult = {
      web: [{ url: "https://low.test", title: "Low", description: "" }],
    };
    const high = vi.fn<() => Promise<SearchV2Response | null>>(
      async () => highResult,
    );
    const low = vi.fn<() => Promise<SearchV2Response | null>>(
      async () => lowResult,
    );

    installSearchService([
      {
        name: "custom",
        searchProviders: [
          {
            name: "searxng",
            priority: 10,
            enabled: () => true,
            search: low,
          },
          {
            name: "duckduckgo",
            priority: 200,
            enabled: () => true,
            search: high,
          },
        ],
      },
    ]);

    const res = await search({ query: "firecrawl", logger });

    expect(res).toEqual(highResult);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
    expect(mocks.searxngSearch).not.toHaveBeenCalled();

    high.mockResolvedValueOnce(null);
    const fallbackRes = await search({ query: "firecrawl", logger });

    expect(fallbackRes).toEqual(lowResult);
    expect(high).toHaveBeenCalledTimes(2);
    expect(low).toHaveBeenCalledTimes(1);
  });

  it("forwards teamPlanClass and query options to extension search providers", async () => {
    const providerSearch = vi.fn(async () => ({ web: [] }));

    installSearchService([
      {
        name: "custom",
        searchProviders: [
          {
            name: "searxng",
            priority: 100,
            enabled: () => true,
            search: providerSearch,
          },
        ],
      },
    ]);

    await search({
      query: "retries",
      logger,
      requestId: "req-1",
      num_results: 8,
      safe: true,
      type: ["web", "news"],
      enterprise: ["zdr"],
      includeDomains: ["firecrawl.dev"],
      excludeDomains: ["example.com"],
      teamPlanClass: "contract",
    });

    expect(providerSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "retries",
        requestId: "req-1",
        numResults: 8,
        safe: true,
        type: ["web", "news"],
        enterprise: ["zdr"],
        includeDomains: ["firecrawl.dev"],
        excludeDomains: ["example.com"],
        teamPlanClass: "contract",
      }),
    );

    providerSearch.mockClear();
    await search({ query: "retries", logger });

    expect(providerSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "retries",
        teamPlanClass: undefined,
      }),
    );
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
  });

  it("refuses US-only search when no enabled provider supports US-only", async () => {
    config.SEARXNG_ENDPOINT = "http://searxng.test";

    await expect(
      search({ query: "firecrawl", logger, usOnly: true }),
    ).rejects.toThrow(UsOnlyUnavailableError);
    expect(mocks.searxngSearch).not.toHaveBeenCalled();
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
  });

  it("routes US-only search only to providers that support US-only without falling back", async () => {
    const usProvider = vi.fn(async () => null);
    installSearchService([
      {
        name: "custom",
        searchProviders: [
          {
            name: "searxng",
            priority: 200,
            supportsUsOnly: true,
            enabled: () => true,
            search: usProvider,
          },
        ],
      },
    ]);

    const res = await search({ query: "firecrawl", logger, usOnly: true });

    expect(res).toEqual({});
    expect(usProvider).toHaveBeenCalledTimes(1);
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
  });

  it("catches provider errors, logs them, and returns an empty response", async () => {
    const failure = new Error("upstream failed");
    installSearchService([
      {
        name: "custom",
        searchProviders: [
          {
            name: "searxng",
            priority: 200,
            enabled: () => true,
            search: async () => {
              throw failure;
            },
          },
        ],
      },
    ]);

    const res = await search({ query: "firecrawl", logger });

    expect(res).toEqual({});
    expect(loggerErrorSpy).toHaveBeenCalledWith("Error in search function", {
      error: failure,
    });
  });
});
