import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fireEngineSearchLegacy: vi.fn(),
  fireEngineSearchV2: vi.fn(),
  searxngSearchLegacy: vi.fn(),
  searxngSearchV2: vi.fn(),
  ddgSearch: vi.fn(),
}));

vi.mock("./fireEngine", () => ({
  fire_engine_search: mocks.fireEngineSearchLegacy,
}));
vi.mock("./v2/fireEngine-v2", () => ({
  fire_engine_search_v2: mocks.fireEngineSearchV2,
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

const originalFireEngineUrl = config.FIRE_ENGINE_BETA_URL;
const originalSearxngEndpoint = config.SEARXNG_ENDPOINT;

beforeEach(() => {
  vi.clearAllMocks();
  config.FIRE_ENGINE_BETA_URL = undefined;
  config.SEARXNG_ENDPOINT = undefined;
});

afterEach(() => {
  config.FIRE_ENGINE_BETA_URL = originalFireEngineUrl;
  config.SEARXNG_ENDPOINT = originalSearxngEndpoint;
});

const byName = (name: string) =>
  coreSearchProviders.find(provider => provider.name === name)!;

describe("coreSearchProviders", () => {
  it("matches coreSearchProviderSpecs in order, priority, and US-only support", () => {
    expect(
      coreSearchProviders.map(provider => ({
        name: provider.name,
        priority: provider.priority,
        ...(provider.supportsUsOnly ? { supportsUsOnly: true } : {}),
      })),
    ).toEqual(coreSearchProviderSpecs);
  });

  it("evaluates enabled() dynamically from config", () => {
    expect(byName("fire-engine").enabled()).toBe(false);
    expect(byName("searxng").enabled()).toBe(false);
    expect(byName("duckduckgo").enabled()).toBe(true);

    config.FIRE_ENGINE_BETA_URL = "http://fire-engine.test";
    config.SEARXNG_ENDPOINT = "http://searxng.test";

    expect(byName("fire-engine").enabled()).toBe(true);
    expect(byName("searxng").enabled()).toBe(true);
    expect(byName("duckduckgo").enabled()).toBe(true);
  });

  it("routes fire-engine between v2 and legacy endpoints and returns empty responses without falling back", async () => {
    mocks.fireEngineSearchV2.mockResolvedValue({ web: [], news: [] });
    const v2Result = await byName("fire-engine").search({
      query: "firecrawl",
      numResults: 5,
      logger,
      requestId: "req-1",
      type: ["web", "news"],
      usOnly: true,
      teamPlanClass: "contract",
    });

    expect(v2Result).toEqual({ web: [], news: [] });
    expect(mocks.fireEngineSearchV2).toHaveBeenCalledWith(
      "firecrawl",
      expect.objectContaining({
        requestId: "req-1",
        numResults: 5,
        type: ["web", "news"],
        usOnly: true,
        teamPlanClass: "contract",
      }),
      undefined,
    );
    expect(mocks.fireEngineSearchLegacy).not.toHaveBeenCalled();

    mocks.fireEngineSearchLegacy.mockResolvedValue([]);
    const legacyResult = await byName("fire-engine").search({
      query: "firecrawl",
      numResults: 5,
      logger,
      legacy: true,
      usOnly: true,
    });

    expect(legacyResult).toEqual({ web: [] });
    expect(mocks.fireEngineSearchLegacy).toHaveBeenCalledWith(
      "firecrawl",
      expect.objectContaining({ numResults: 5, usOnly: true }),
      undefined,
    );
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
});
