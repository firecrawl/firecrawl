import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searxngSearchLegacy: vi.fn(),
  searxngSearchV2: vi.fn(),
  ddgSearch: vi.fn(),
}));

vi.mock("./searxng", () => ({
  searxng_search: mocks.searxngSearchLegacy,
}));
vi.mock("./v2/searxng", () => ({
  searxng_search: mocks.searxngSearchV2,
}));
vi.mock("./v2/ddgsearch", () => ({
  ddgSearch: mocks.ddgSearch,
}));

import { config } from "../config";
import { coreSearchProviderSpecs } from "../service/search-providers";
import { coreSearchProviders } from "./providers";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const originalSearxngEndpoint = config.SEARXNG_ENDPOINT;

beforeEach(() => {
  vi.clearAllMocks();
  config.SEARXNG_ENDPOINT = undefined;
});

afterEach(() => {
  config.SEARXNG_ENDPOINT = originalSearxngEndpoint;
});

const byName = (name: string) =>
  coreSearchProviders.find(provider => provider.name === name)!;

describe("coreSearchProviders", () => {
  it("registers only SearXNG and DuckDuckGo matching coreSearchProviderSpecs", () => {
    expect(coreSearchProviders.map(provider => provider.name)).toEqual([
      "searxng",
      "duckduckgo",
    ]);
    expect(
      coreSearchProviders.map(provider => ({
        name: provider.name,
        priority: provider.priority,
        ...(provider.supportsUsOnly ? { supportsUsOnly: true } : {}),
      })),
    ).toEqual(coreSearchProviderSpecs);
  });

  it("evaluates enabled() dynamically from config", () => {
    expect(byName("searxng").enabled()).toBe(false);
    expect(byName("duckduckgo").enabled()).toBe(true);

    config.SEARXNG_ENDPOINT = "http://searxng.test";

    expect(byName("searxng").enabled()).toBe(true);
    expect(byName("duckduckgo").enabled()).toBe(true);
  });

  it("returns null from searxng when results are empty or filtered out by domains", async () => {
    mocks.searxngSearchV2.mockResolvedValue({
      web: [{ url: "https://example.com", title: "Example", description: "" }],
    });

    const filteredOut = await byName("searxng").search({
      query: "firecrawl",
      numResults: 5,
      logger,
      includeDomains: ["firecrawl.dev"],
    });
    expect(filteredOut).toBeNull();

    mocks.searxngSearchLegacy.mockResolvedValue([]);
    const legacyEmpty = await byName("searxng").search({
      query: "firecrawl",
      numResults: 5,
      logger,
      legacy: true,
    });
    expect(legacyEmpty).toBeNull();
  });

  it("preserves DuckDuckGo options without forwarding location and filters domains in v2", async () => {
    mocks.ddgSearch.mockResolvedValue({
      web: [
        { url: "https://example.com", title: "Example", description: "" },
        { url: "https://firecrawl.dev", title: "Firecrawl", description: "" },
      ],
    });

    const result = await byName("duckduckgo").search({
      query: "firecrawl",
      numResults: 7,
      logger,
      tbs: "d",
      lang: "en",
      country: "us",
      location: "San Francisco,California,United States",
      proxy: "http://proxy.test",
      timeout: 3000,
      includeDomains: ["firecrawl.dev"],
    });

    expect(mocks.ddgSearch).toHaveBeenCalledWith("firecrawl", 7, {
      tbs: "d",
      lang: "en",
      country: "us",
      proxy: "http://proxy.test",
      timeout: 3000,
    });
    expect(result).toEqual({
      web: [
        { url: "https://firecrawl.dev", title: "Firecrawl", description: "" },
      ],
    });
  });

  it("returns null from DuckDuckGo when legacy search returns no results", async () => {
    mocks.ddgSearch.mockResolvedValue({ web: [] });

    const result = await byName("duckduckgo").search({
      query: "firecrawl",
      numResults: 5,
      logger,
      legacy: true,
    });

    expect(result).toBeNull();
  });
});
