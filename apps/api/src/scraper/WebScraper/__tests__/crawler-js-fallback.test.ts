import type { Mocked, MockedFunction } from "vitest";
import { DenialReason, WebCrawler } from "../crawler";
import axios from "axios";
import robotsParser from "robots-parser";

// Force the native filter to throw so WebCrawler.filterLinks takes the JS fallback.
vi.mock("@mendable/firecrawl-rs", () => ({
  filterLinks: vi.fn(() => {
    throw new Error("native filter unavailable");
  }),
  extractLinks: vi.fn(),
  filterUrl: vi.fn(),
  validateRegexes: vi.fn(),
}));
vi.mock("axios");
vi.mock("robots-parser");

describe("WebCrawler.filterLinks JS fallback host scoping", () => {
  const mockAxios = axios as Mocked<typeof axios>;
  const mockRobotsParser = robotsParser as MockedFunction<typeof robotsParser>;

  beforeEach(() => {
    mockAxios.get.mockResolvedValue({ data: "<html></html>" });
    mockRobotsParser.mockReturnValue({
      isAllowed: vi.fn().mockReturnValue(true),
      isDisallowed: vi.fn().mockReturnValue(false),
      getMatchingLineNumber: vi.fn().mockReturnValue(0),
      getCrawlDelay: vi.fn().mockReturnValue(0),
      getSitemaps: vi.fn().mockReturnValue([]),
      getPreferredHost: vi.fn().mockReturnValue("example.com"),
    });
  });

  const links = [
    "https://example.com/a",
    "https://www.example.com/b",
    "https://sub.example.com/c",
    "https://other.com/d",
    "https://notexample.com/e",
  ];

  const run = async (
    opts: {
      allowExternalContentLinks?: boolean;
      allowSubdomains?: boolean;
    },
    {
      initialUrl = "https://example.com",
      baseUrl,
      input = links,
    }: { initialUrl?: string; baseUrl?: string; input?: string[] } = {},
  ) => {
    const crawler = new WebCrawler({
      jobId: "TEST",
      initialUrl,
      includes: [],
      excludes: [],
      limit: 10,
      maxCrawledDepth: 10,
      ...opts,
    });
    if (baseUrl) crawler.setBaseUrl(baseUrl);
    return await crawler["filterLinks"](input, 10, 10);
  };

  it("denies external hosts and subdomains by default", async () => {
    const { links: kept, denialReasons } = await run({});
    expect(kept).toEqual([
      "https://example.com/a",
      "https://www.example.com/b",
    ]);
    expect(denialReasons.get("https://other.com/d")).toBe(
      DenialReason.EXTERNAL_LINK,
    );
  });

  it("allows subdomains but not external hosts when allowSubdomains is set", async () => {
    expect((await run({ allowSubdomains: true })).links).toEqual([
      "https://example.com/a",
      "https://www.example.com/b",
      "https://sub.example.com/c",
    ]);
  });

  it("allows external hosts when allowExternalContentLinks is set", async () => {
    expect((await run({ allowExternalContentLinks: true })).links).toEqual(
      links,
    );
  });

  it("scopes to the base URL after a redirect to another host", async () => {
    const result = await run(
      {},
      {
        baseUrl: "https://www.example.org/start",
        input: ["https://www.example.org/next", "https://example.com/z"],
      },
    );
    expect(result.links).toEqual(["https://www.example.org/next"]);
  });

  it("allows the parent and sibling subdomains of a subdomain start URL", async () => {
    const input = [
      "https://example.com/x",
      "https://blog.example.com/y",
      "https://api.docs.example.com/z",
      "https://other.com/w",
    ];
    const result = await run(
      { allowSubdomains: true },
      { initialUrl: "https://docs.example.com", input },
    );
    expect(result.links).toEqual(input.slice(0, 3));
  });

  it("follows external links only from pages on the initial host", async () => {
    const result = await run(
      { allowExternalContentLinks: true },
      {
        baseUrl: "https://elsewhere.com",
        input: ["https://elsewhere.com/a", "https://other.com/d"],
      },
    );
    expect(result.links).toEqual(["https://elsewhere.com/a"]);
  });
});
