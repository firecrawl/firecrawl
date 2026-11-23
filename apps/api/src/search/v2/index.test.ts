const mocks = vi.hoisted(() => ({
  attemptRequest: vi.fn(),
  searxngSearch: vi.fn(),
  ddgSearch: vi.fn(),
}));

vi.mock("../../lib/retry-utils", () => ({
  attemptRequest: mocks.attemptRequest,
  executeWithRetry: async (attempt: () => Promise<unknown>) => attempt(),
}));
vi.mock("../../scraper/scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: true,
}));
vi.mock("./searxng", () => ({ searxng_search: mocks.searxngSearch }));
vi.mock("./ddgsearch", () => ({ ddgSearch: mocks.ddgSearch }));

import { config } from "../../config";
import { search } from "./index";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const originalFireEngineUrl = config.FIRE_ENGINE_BETA_URL;

beforeEach(() => {
  vi.clearAllMocks();
  config.FIRE_ENGINE_BETA_URL = "http://fire-engine.test";
  mocks.attemptRequest.mockResolvedValue({ web: [] });
});

afterEach(() => {
  config.FIRE_ENGINE_BETA_URL = originalFireEngineUrl;
});

const sentBody = () => JSON.parse(mocks.attemptRequest.mock.calls[0][1]);

describe("the team plan class on the fire engine search call", () => {
  it.each(["free", "self_serve", "contract"] as const)(
    "sends %s when the caller states it",
    async teamPlanClass => {
      await search({ query: "retries", logger, teamPlanClass });

      expect(mocks.attemptRequest).toHaveBeenCalledTimes(1);
      expect(mocks.attemptRequest.mock.calls[0][0]).toBe(
        "http://fire-engine.test/v2/search",
      );
      expect(sentBody()).toMatchObject({ query: "retries", teamPlanClass });
    },
  );

  it("sends no plan class when the caller states none", async () => {
    await search({ query: "retries", logger });

    expect(mocks.attemptRequest).toHaveBeenCalledTimes(1);
    expect(sentBody()).not.toHaveProperty("teamPlanClass");
  });
});

describe("domain filters on the SearXNG and DuckDuckGo results", () => {
  const originalSearxngEndpoint = config.SEARXNG_ENDPOINT;
  const result = (url: string) => ({ url, title: url, description: "" });

  beforeEach(() => {
    config.FIRE_ENGINE_BETA_URL = undefined;
    config.SEARXNG_ENDPOINT = "http://searxng.test";
    mocks.ddgSearch.mockResolvedValue({});
  });

  afterEach(() => {
    config.SEARXNG_ENDPOINT = originalSearxngEndpoint;
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
