const mocks = vi.hoisted(() => ({
  config: {
    FIRE_ENGINE_BETA_URL: "https://fire-engine.test" as string | undefined,
    SEARXNG_ENDPOINT: undefined as string | undefined,
  },
  fireEngineSearch: vi.fn(),
  searxngSearch: vi.fn(),
  ddgSearch: vi.fn(),
  searchV2: vi.fn(),
}));

vi.mock("../config", () => ({
  config: mocks.config,
}));
vi.mock("./fireEngine", () => ({ fire_engine_search: mocks.fireEngineSearch }));
vi.mock("./searxng", () => ({ searxng_search: mocks.searxngSearch }));
vi.mock("./v2/ddgsearch", () => ({ ddgSearch: mocks.ddgSearch }));
vi.mock("./v2", () => ({ search: mocks.searchV2 }));

import { UsOnlyUnavailableError } from "../scraper/scrapeURL/error";
import type { SearchProvider } from "../service";
import { createService, replaceService } from "../service/service";
import { search } from "./index";
import { coreSearchProviders } from "./providers";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function installSearchService(
  extensions: Array<{
    name: string;
    searchProviders?: readonly SearchProvider[];
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
  mocks.config.FIRE_ENGINE_BETA_URL = "https://fire-engine.test";
  mocks.config.SEARXNG_ENDPOINT = undefined;
  installSearchService();
});

afterEach(() => {
  replaceService(undefined);
  vi.clearAllMocks();
});

describe("legacy search", () => {
  it.each(["zdr", "anon"] as const)(
    "sends a forced %s search through the v2 search with its kind",
    async kind => {
      mocks.searchV2.mockResolvedValue({
        web: [
          {
            url: "https://example.com/",
            title: "Example",
            description: "An example",
            position: 1,
          },
        ],
      });

      const results = await search({
        query: "example",
        logger,
        num_results: 5,
        usOnly: false,
        enterprise: [kind],
      });

      expect(mocks.fireEngineSearch).not.toHaveBeenCalled();
      expect(mocks.searchV2).toHaveBeenCalledTimes(1);
      expect(mocks.searchV2.mock.calls[0][0]).toMatchObject({
        query: "example",
        num_results: 5,
        enterprise: [kind],
      });
      expect(results).toEqual([
        {
          url: "https://example.com/",
          title: "Example",
          description: "An example",
        },
      ]);
    },
  );

  it("returns no results when the v2 search finds none", async () => {
    mocks.searchV2.mockResolvedValue({});

    const results = await search({
      query: "example",
      logger,
      enterprise: ["zdr"],
    });

    expect(results).toEqual([]);
    expect(mocks.fireEngineSearch).not.toHaveBeenCalled();
  });

  it("keeps the legacy route when no kind is forced", async () => {
    mocks.fireEngineSearch.mockResolvedValue([]);

    await search({ query: "example", logger, num_results: 5 });

    expect(mocks.searchV2).not.toHaveBeenCalled();
    expect(mocks.fireEngineSearch).toHaveBeenCalledTimes(1);
    expect(mocks.fireEngineSearch.mock.calls[0][0]).toBe("example");
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
  });

  it("falls back from SearXNG to DuckDuckGo when SearXNG returns no results", async () => {
    mocks.config.FIRE_ENGINE_BETA_URL = undefined;
    mocks.config.SEARXNG_ENDPOINT = "http://searxng.test";
    mocks.searxngSearch.mockResolvedValue([]);
    mocks.ddgSearch.mockResolvedValue({
      web: [
        {
          url: "https://ddg.example.com/",
          title: "DDG",
          description: "Fallback",
        },
      ],
    });

    const results = await search({ query: "example", logger, num_results: 5 });

    expect(mocks.searxngSearch).toHaveBeenCalledTimes(1);
    expect(mocks.ddgSearch).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      {
        url: "https://ddg.example.com/",
        title: "DDG",
        description: "Fallback",
      },
    ]);
  });

  it("refuses US-only legacy search when no US-only provider is enabled", async () => {
    mocks.config.FIRE_ENGINE_BETA_URL = undefined;

    await expect(
      search({ query: "example", logger, usOnly: true }),
    ).rejects.toThrow(UsOnlyUnavailableError);
    expect(mocks.ddgSearch).not.toHaveBeenCalled();
  });

  it("forwards usOnly to v2 search when an enterprise kind is forced", async () => {
    mocks.searchV2.mockRejectedValue(
      new UsOnlyUnavailableError("US-only search unavailable"),
    );

    await expect(
      search({ query: "example", logger, usOnly: true, enterprise: ["zdr"] }),
    ).rejects.toThrow(UsOnlyUnavailableError);
    expect(mocks.searchV2).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "example",
        usOnly: true,
        enterprise: ["zdr"],
      }),
    );
  });

  it("routes legacy search through custom extension providers by priority", async () => {
    const customSearch = vi.fn(async () => ({
      web: [
        {
          url: "https://custom.example.com/",
          title: "Custom",
          description: "Override",
        },
      ],
    }));

    installSearchService([
      {
        name: "custom",
        searchProviders: [
          {
            name: "custom-search" as SearchProvider["name"],
            priority: 200,
            enabled: () => true,
            search: customSearch,
          },
        ],
      },
    ]);

    const results = await search({ query: "example", logger, num_results: 3 });

    expect(customSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "example",
        numResults: 3,
        legacy: true,
      }),
    );
    expect(mocks.fireEngineSearch).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        url: "https://custom.example.com/",
        title: "Custom",
        description: "Override",
      },
    ]);
  });
});
