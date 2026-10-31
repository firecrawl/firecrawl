import type { Mocked, MockedFunction } from "vitest";
// crawler.test.ts
vi.mock("@mendable/firecrawl-rs", () => ({
  extractLinks: vi.fn(),
  filterLinks: vi.fn().mockRejectedValue(new Error("Simulate Rust fallback")),
  filterUrl: vi.fn(),
  validateRegexes: vi.fn(),
}));

import { WebCrawler } from "../crawler";
import axios from "axios";
import robotsParser from "robots-parser";

vi.mock("axios");
vi.mock("robots-parser");

describe("WebCrawler", () => {
  let crawler: WebCrawler;
  const mockAxios = axios as Mocked<typeof axios>;
  const mockRobotsParser = robotsParser as MockedFunction<typeof robotsParser>;

  let maxCrawledDepth: number;

  beforeEach(() => {
    // Setup default mocks
    mockAxios.get.mockImplementation(url => {
      if (url.includes("robots.txt")) {
        return Promise.resolve({ data: "User-agent: *\nAllow: /" });
      } else if (url.includes("sitemap.xml")) {
        return Promise.resolve({ data: "sitemap content" }); // You would normally parse this to URLs
      }
      return Promise.resolve({ data: "<html></html>" });
    });

    mockRobotsParser.mockReturnValue({
      isAllowed: vi.fn().mockReturnValue(true),
      isDisallowed: vi.fn().mockReturnValue(false),
      getMatchingLineNumber: vi.fn().mockReturnValue(0),
      getCrawlDelay: vi.fn().mockReturnValue(0),
      getSitemaps: vi.fn().mockReturnValue([]),
      getPreferredHost: vi.fn().mockReturnValue("example.com"),
    });
  });

  it("should respect the limit parameter by not returning more links than specified", async () => {
    const initialUrl = "http://example.com";
    const limit = 2; // Set a limit for the number of links

    crawler = new WebCrawler({
      jobId: "TEST",
      initialUrl: initialUrl,
      includes: [],
      excludes: [],
      limit: limit, // Apply the limit
      maxCrawledDepth: 10,
    });

    // Mock sitemap fetching function to return more links than the limit
    crawler["tryFetchSitemapLinks"] = vi
      .fn()
      .mockResolvedValue([
        initialUrl,
        initialUrl + "/page1",
        initialUrl + "/page2",
        initialUrl + "/page3",
      ]);

    const filteredLinks = await crawler["filterLinks"](
      [
        initialUrl,
        initialUrl + "/page1",
        initialUrl + "/page2",
        initialUrl + "/page3",
      ],
      limit,
      10,
    );

    expect(filteredLinks.links.length).toBe(limit); // Check if the number of results respects the limit
    expect(filteredLinks.links).toEqual([initialUrl, initialUrl + "/page1"]);
  });

  it("should filter subdomain URLs with includePaths when allowSubdomains is true", async () => {
    const initialUrl = "https://example.com";

    crawler = new WebCrawler({
      jobId: "TEST",
      initialUrl: initialUrl,
      includes: ["^/pricing$"], // Only allow /pricing path
      excludes: [],
      limit: 10,
      maxCrawledDepth: 10,
      allowSubdomains: true,
    });

    const linksToFilter = [
      "https://example.com/pricing", // Should pass: base domain + /pricing
      "https://example.com/blog", // Should fail: base domain but wrong path
      "https://sub.example.com/pricing", // Should pass: subdomain + /pricing
      "https://sub.example.com/about", // Should fail: subdomain but wrong path
      "https://other.example.com/pricing", // Should pass: subdomain + /pricing
      "https://other.example.com/contact", // Should fail: subdomain but wrong path
    ];

    const filteredLinks = await crawler["filterLinks"](linksToFilter, 10, 10);

    expect(filteredLinks.links.length).toBe(3);
    expect(filteredLinks.links).toContain("https://example.com/pricing");
    expect(filteredLinks.links).toContain("https://sub.example.com/pricing");
    expect(filteredLinks.links).toContain("https://other.example.com/pricing");

    // Verify denied links
    expect(filteredLinks.denialReasons.has("https://example.com/blog")).toBe(
      true,
    );
    expect(
      filteredLinks.denialReasons.has("https://sub.example.com/about"),
    ).toBe(true);
    expect(
      filteredLinks.denialReasons.has("https://other.example.com/contact"),
    ).toBe(true);
  });

  it("should filter subdomain URLs with includePaths using regexOnFullURL", async () => {
    const initialUrl = "https://example.com";

    crawler = new WebCrawler({
      jobId: "TEST",
      initialUrl: initialUrl,
      includes: ["^https://([a-z0-9-]+\\.)?example\\.com/pricing$"], // Full URL pattern
      excludes: [],
      limit: 10,
      maxCrawledDepth: 10,
      allowSubdomains: true,
      regexOnFullURL: true,
    });

    const linksToFilter = [
      "https://example.com/pricing", // Should pass: matches pattern
      "https://example.com/pricing/details", // Should fail: doesn't match exact pattern
      "https://sub.example.com/pricing", // Should pass: subdomain + /pricing
      "https://api.example.com/pricing", // Should pass: subdomain + /pricing
      "https://sub.example.com/blog", // Should fail: wrong path
    ];

    const filteredLinks = await crawler["filterLinks"](linksToFilter, 10, 10);

    expect(filteredLinks.links.length).toBe(3);
    expect(filteredLinks.links).toContain("https://example.com/pricing");
    expect(filteredLinks.links).toContain("https://sub.example.com/pricing");
    expect(filteredLinks.links).toContain("https://api.example.com/pricing");

    // Verify denied links
    expect(
      filteredLinks.denialReasons.has("https://example.com/pricing/details"),
    ).toBe(true);
    expect(
      filteredLinks.denialReasons.has("https://sub.example.com/blog"),
    ).toBe(true);
  });

  it("can validate the source URL without applying maxDiscoveryDepth", async () => {
    const initialUrl = "https://example.com/blog";

    crawler = new WebCrawler({
      jobId: "TEST",
      initialUrl,
      includes: ["^/blog"],
      excludes: [],
      limit: 10,
      maxCrawledDepth: 10,
      maxDiscoveryDepth: 0,
      currentDiscoveryDepth: 0,
    });

    const discoveryResult = await crawler["filterLinks"]([initialUrl], 1, 10);
    expect(discoveryResult.links).toEqual([]);

    const sourceValidationResult = await crawler["filterLinks"](
      [initialUrl],
      1,
      10,
      false,
      false,
      true,
    );
    expect(sourceValidationResult.links).toEqual([initialUrl]);
  });

  describe("host scoping in JS fallback", () => {
    it("should reject external links when allowExternalContentLinks is false", async () => {
      crawler = new WebCrawler({
        jobId: "TEST",
        initialUrl: "https://example.com",
        allowExternalContentLinks: false,
        allowSubdomains: false,
      });

      const links = ["https://example.com/page", "https://external.com/page"];

      const res = await crawler["filterLinks"](links, 10, 10);
      expect(res.links).toEqual(["https://example.com/page"]);
      expect(res.denialReasons.has("https://external.com/page")).toBe(true);
    });

    it("should reject subdomain links when allowSubdomains is false", async () => {
      crawler = new WebCrawler({
        jobId: "TEST",
        initialUrl: "https://example.com",
        allowExternalContentLinks: false,
        allowSubdomains: false,
      });

      const links = [
        "https://example.com/page",
        "https://sub.example.com/page",
      ];

      const res = await crawler["filterLinks"](links, 10, 10);
      expect(res.links).toEqual(["https://example.com/page"]);
      expect(res.denialReasons.has("https://sub.example.com/page")).toBe(true);
    });

    it("should allow external links when allowExternalContentLinks is true", async () => {
      crawler = new WebCrawler({
        jobId: "TEST",
        initialUrl: "https://example.com",
        allowExternalContentLinks: true,
        allowSubdomains: false,
      });

      const links = ["https://example.com/page", "https://external.com/page"];

      const res = await crawler["filterLinks"](links, 10, 10);
      expect(res.links).toContain("https://example.com/page");
      expect(res.links).toContain("https://external.com/page");
    });

    it("should allow subdomain links when allowSubdomains is true", async () => {
      crawler = new WebCrawler({
        jobId: "TEST",
        initialUrl: "https://example.com",
        allowExternalContentLinks: false,
        allowSubdomains: true,
      });

      const links = [
        "https://example.com/page",
        "https://sub.example.com/page",
      ];

      const res = await crawler["filterLinks"](links, 10, 10);
      expect(res.links).toContain("https://example.com/page");
      expect(res.links).toContain("https://sub.example.com/page");
    });

    it("should identify files with fragment hashes in isFile", () => {
      crawler = new WebCrawler({
        jobId: "TEST",
        initialUrl: "https://example.com",
      });

      expect(crawler.isFile("https://example.com/download.zip#section")).toBe(
        true,
      );
      expect(
        crawler.isFile("https://example.com/image.png?size=large#top"),
      ).toBe(true);
    });
  });
});
