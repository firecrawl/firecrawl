import { z } from "zod";
import {
  scrapeRequestSchema,
  scrapeOptions,
  extractRequestSchema,
  crawlRequestSchema,
  mapRequestSchema,
  batchScrapeRequestSchema,
  searchRequestSchema,
  ScrapeRequest,
  ScrapeRequestInput,
  ExtractRequest,
  ExtractRequestInput,
  CrawlRequest,
  CrawlRequestInput,
  MapRequest,
  MapRequestInput,
  BatchScrapeRequest,
  BatchScrapeRequestInput,
  SearchRequest,
  SearchRequestInput,
} from "../../../controllers/v2/types";

describe("V2 Types Validation", () => {
  describe("scrapeRequestSchema", () => {
    it("should accept valid minimal scrape request", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.origin).toBe("api");
      expect(result.formats).toEqual([{ type: "markdown" }]);
    });

    it("should accept valid scrape request with format objects", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [{ type: "markdown" }, { type: "html" }],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toEqual([{ type: "markdown" }, { type: "html" }]);
    });

    it("should accept valid scrape request with string formats (preprocessed)", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["markdown", "html"],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toEqual([{ type: "markdown" }, { type: "html" }]);
    });

    it("should accept valid scrape request with json format options", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          {
            type: "json",
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
            },
          },
        ],
        timeout: 30000,
        proxy: "basic", // Use basic proxy to avoid auto/stealth timeout transformation
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toHaveLength(1);
      expect(result.formats[0].type).toBe("json");
      expect(result.timeout).toBe(60000); // Should be transformed from 30000
    });

    it("should accept valid scrape request with changeTracking format", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          { type: "markdown" },
          {
            type: "changeTracking",
            schema: {
              type: "object",
              properties: {
                changes: { type: "array" },
              },
            },
            modes: ["json"],
            tag: "test-tag",
          },
        ],
        timeout: 30000,
        proxy: "basic", // Use basic proxy to avoid auto/stealth timeout transformation
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toHaveLength(2);
      expect(result.timeout).toBe(60000); // Should be transformed
      expect(result.waitFor).toBeGreaterThanOrEqual(5000); // Should be at least 5000
    });

    it("should reject changeTracking without markdown", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          {
            type: "changeTracking",
          },
        ],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "The changeTracking format requires the markdown format to be specified as well",
      );
    });

    it("should reject multiple screenshot formats", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          { type: "screenshot", fullPage: false },
          { type: "screenshot", fullPage: true },
        ],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "You may only specify one screenshot format",
      );
    });

    it("should accept screenshot format with options", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          {
            type: "screenshot",
            fullPage: true,
            quality: 90,
            viewport: {
              width: 1920,
              height: 1080,
            },
          },
        ],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats[0].type).toBe("screenshot");
      expect((result.formats[0] as any).fullPage).toBe(true);
      expect((result.formats[0] as any).quality).toBe(90);
    });

    it("should accept attributes format with selectors", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          {
            type: "attributes",
            selectors: [
              {
                selector: ".product",
                attribute: "data-product-id",
              },
            ],
          },
        ],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats[0].type).toBe("attributes");
      expect((result.formats[0] as any).selectors).toHaveLength(1);
    });

    it("should reject invalid URL", () => {
      const input = {
        url: "not-a-url",
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
    });

    it("should reject missing URL", () => {
      const input = {};

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
    });

    it("should reject waitFor exceeding timeout/2", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        timeout: 1000,
        waitFor: 600,
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "waitFor must not exceed half of timeout",
      );
    });

    it("should accept waitFor within timeout/2", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        timeout: 1000,
        waitFor: 400,
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.waitFor).toBe(400);
      expect(result.timeout).toBe(1000);
    });

    it("should apply default values correctly", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.origin).toBe("api");
      expect(result.formats).toEqual([{ type: "markdown" }]);
      expect(result.onlyMainContent).toBe(true);
      expect(result.waitFor).toBe(0);
      expect(result.mobile).toBe(false);
      expect(result.removeBase64Images).toBe(true);
      expect(result.fastMode).toBe(false);
      expect(result.blockAds).toBe(true);
      expect(result.proxy).toBe("auto"); // v2 default is "auto"
      expect(result.storeInCache).toBe(true);
    });

    it("should accept valid integration value", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        integration: "dify",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.integration).toBe("dify");
    });

    it("should accept integration value starting with underscore", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        integration: "_custom",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.integration).toBe("_custom");
    });

    it("should reject invalid integration value", () => {
      const input = {
        url: "https://example.com",
        integration: "invalid-integration",
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "Invalid enum value",
      );
    });

    it("should handle iframe selector transformation", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        includeTags: ["iframe", "div"],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.includeTags).toContain('div[data-original-tag="iframe"]');
    });

    it("should handle parsers with PDF options", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        parsers: [
          {
            type: "pdf",
            maxPages: 100,
          },
        ],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.parsers).toBeDefined();
      expect((result.parsers as any)[0].type).toBe("pdf");
      expect((result.parsers as any)[0].maxPages).toBe(100);
    });

    it("should reject PDF parser with maxPages exceeding limit", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        parsers: [
          {
            type: "pdf",
            maxPages: 20000,
          },
        ],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
    });

    it("should handle stealth proxy timeout transformation", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        proxy: "stealth",
        timeout: 30000,
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.timeout).toBe(120000); // Should be transformed
    });

    it("should handle auto proxy timeout transformation", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        proxy: "auto",
        timeout: 30000,
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.timeout).toBe(120000); // Should be transformed
    });

    it("should handle location schema with valid country code", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        location: {
          country: "US",
          languages: ["en"],
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.location?.country).toBe("us"); // Should be transformed to lowercase
      expect(result.location?.languages).toEqual(["en"]);
    });

    it("should reject location schema with invalid country code", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        location: {
          country: "INVALID",
        },
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "Invalid country code",
      );
    });

    it("should handle valid actions", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        actions: [
          { type: "click", selector: "button" },
          { type: "wait", milliseconds: 1000 },
          { type: "scroll", direction: "down" },
        ],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.actions).toHaveLength(3);
      expect(result.actions?.[0].type).toBe("click");
      expect(result.actions?.[1].type).toBe("wait");
    });

    it("should reject wait action with both milliseconds and selector", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        actions: [
          {
            type: "wait",
            milliseconds: 1000,
            selector: "button",
          },
        ],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "Either 'milliseconds' or 'selector' must be provided, but not both",
      );
    });

    it("should reject more than 50 actions", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        actions: Array.from({ length: 51 }, () => ({
          type: "click" as const,
          selector: "button",
        })),
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "Number of actions cannot exceed 50",
      );
    });

    it("should handle screenshot action with viewport", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        actions: [
          {
            type: "screenshot",
            fullPage: false,
            quality: 90,
            viewport: {
              width: 1920,
              height: 1080,
            },
          },
        ],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.actions?.[0].type).toBe("screenshot");
    });

    it("should reject screenshot action with invalid viewport dimensions", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        actions: [
          {
            type: "screenshot",
            viewport: {
              width: 10000, // Exceeds max
              height: 1080,
            },
          },
        ],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
    });
  });

  describe("extractRequestSchema", () => {
    it("should accept valid extract request with urls", () => {
      const input: ExtractRequestInput = {
        urls: ["https://example.com"],
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      };

      const result = extractRequestSchema.parse(input);
      expect(result.urls).toEqual(["https://example.com"]);
      expect(result.origin).toBe("api");
      expect(result.ignoreInvalidURLs).toBe(true); // v2 default is true
    });

    it("should accept valid extract request with prompt", () => {
      const input: ExtractRequestInput = {
        prompt: "Extract the title",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      };

      const result = extractRequestSchema.parse(input);
      expect(result.prompt).toBe("Extract the title");
    });

    it("should reject extract request without urls or prompt", () => {
      const input = {
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      };

      expect(() => extractRequestSchema.parse(input)).toThrow(
        "Either 'urls' or 'prompt' must be provided",
      );
    });

    it("should reject more than 10 URLs", () => {
      const input: ExtractRequestInput = {
        urls: Array.from({ length: 11 }, (_, i) => `https://example${i}.com`),
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      };

      expect(() => extractRequestSchema.parse(input)).toThrow(
        "Maximum of 10 URLs allowed per request while in beta",
      );
    });

    it("should accept up to 10 URLs", () => {
      const input: ExtractRequestInput = {
        urls: Array.from({ length: 10 }, (_, i) => `https://example${i}.com`),
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      };

      const result = extractRequestSchema.parse(input);
      expect(result.urls).toHaveLength(10);
    });

    it("should reject invalid JSON schema", () => {
      const input: ExtractRequestInput = {
        urls: ["https://example.com"],
        schema: {
          type: "invalid-type",
          properties: "not-an-object",
        },
      };

      expect(() => extractRequestSchema.parse(input)).toThrow(
        "Invalid JSON schema",
      );
    });

    it("should transform allowExternalLinks when enableWebSearch is true", () => {
      const input: ExtractRequestInput = {
        urls: ["https://example.com"],
        enableWebSearch: true,
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      };

      const result = extractRequestSchema.parse(input);
      expect(result.allowExternalLinks).toBe(true);
    });
  });

  describe("crawlRequestSchema", () => {
    it("should accept valid minimal crawl request", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.origin).toBe("api");
      expect(result.limit).toBe(10000);
      expect(result.scrapeOptions).toBeDefined();
      expect(result.sitemap).toBe("include");
    });

    it("should accept valid crawl request with all crawler options", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
        includePaths: ["/blog"],
        excludePaths: ["/admin"],
        maxDiscoveryDepth: 10,
        limit: 5000,
        crawlEntireDomain: true,
        allowExternalLinks: true,
        allowSubdomains: true,
        ignoreRobotsTxt: true,
        sitemap: "skip",
        deduplicateSimilarURLs: false,
        ignoreQueryParameters: true,
        regexOnFullURL: true,
        delay: 1000,
        prompt: "Extract blog posts",
        scrapeOptions: {
          formats: [{ type: "markdown" }],
        },
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.maxDiscoveryDepth).toBe(10);
      expect(result.crawlEntireDomain).toBe(true);
      expect(result.sitemap).toBe("skip");
      expect(result.prompt).toBe("Extract blog posts");
    });

    it("should apply default scrapeOptions when not provided", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.scrapeOptions).toBeDefined();
      expect(result.scrapeOptions.formats).toEqual([{ type: "markdown" }]);
    });

    it("should handle sitemap enum values", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
        sitemap: "include",
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.sitemap).toBe("include");
    });

    it("should reject invalid sitemap value", () => {
      const input = {
        url: "https://example.com",
        sitemap: "invalid",
      };

      expect(() => crawlRequestSchema.parse(input)).toThrow();
    });
  });

  describe("mapRequestSchema", () => {
    it("should accept valid minimal map request", () => {
      const input: MapRequestInput = {
        url: "https://example.com",
      };

      const result = mapRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.origin).toBe("api");
      expect(result.limit).toBe(5000);
      expect(result.includeSubdomains).toBe(true);
      expect(result.ignoreQueryParameters).toBe(true);
      expect(result.sitemap).toBe("include");
      expect(result.filterByPath).toBe(true);
      expect(result.useIndex).toBe(true);
    });

    it("should reject limit exceeding MAX_MAP_LIMIT", () => {
      const input: MapRequestInput = {
        url: "https://example.com",
        limit: 200000,
      };

      expect(() => mapRequestSchema.parse(input)).toThrow();
    });

    it("should reject limit below 1", () => {
      const input: MapRequestInput = {
        url: "https://example.com",
        limit: 0,
      };

      expect(() => mapRequestSchema.parse(input)).toThrow();
    });

    it("should accept limit within valid range", () => {
      const input: MapRequestInput = {
        url: "https://example.com",
        limit: 10000,
      };

      const result = mapRequestSchema.parse(input);
      expect(result.limit).toBe(10000);
    });

    it("should handle sitemap enum values", () => {
      const input: MapRequestInput = {
        url: "https://example.com",
        sitemap: "only",
      };

      const result = mapRequestSchema.parse(input);
      expect(result.sitemap).toBe("only");
    });
  });

  describe("batchScrapeRequestSchema", () => {
    it("should accept valid batch scrape request", () => {
      const input: BatchScrapeRequestInput = {
        urls: ["https://example.com", "https://example.org"],
      };

      const result = batchScrapeRequestSchema.parse(input);
      expect(result.urls).toHaveLength(2);
      expect(result.origin).toBe("api");
      expect(result.ignoreInvalidURLs).toBe(true); // v2 default is true
    });

    it("should reject empty urls array", () => {
      const input = {
        urls: [],
      };

      expect(() => batchScrapeRequestSchema.parse(input)).toThrow();
    });

    it("should accept valid UUID for appendToId", () => {
      const input: BatchScrapeRequestInput = {
        urls: ["https://example.com"],
        appendToId: "123e4567-e89b-12d3-a456-426614174000",
      };

      const result = batchScrapeRequestSchema.parse(input);
      expect(result.appendToId).toBe("123e4567-e89b-12d3-a456-426614174000");
    });

    it("should reject invalid UUID for appendToId", () => {
      const input = {
        urls: ["https://example.com"],
        appendToId: "not-a-uuid",
      };

      expect(() => batchScrapeRequestSchema.parse(input)).toThrow();
    });
  });

  describe("searchRequestSchema", () => {
    it("should accept valid minimal search request", () => {
      const input: SearchRequestInput = {
        query: "test query",
      };

      const result = searchRequestSchema.parse(input);
      expect(result.query).toBe("test query");
      expect(result.limit).toBe(10); // v2 default is 10
      expect(result.lang).toBe("en");
      expect(result.origin).toBe("api");
      // Sources are transformed from string array to object array
      expect(result.sources).toEqual([
        {
          type: "web",
          tbs: undefined,
          filter: undefined,
          lang: "en",
          country: "us",
          location: undefined,
        },
      ]);
    });

    it("should accept search request with simple sources array", () => {
      const input: SearchRequestInput = {
        query: "test",
        sources: ["web", "images"],
      };

      const result = searchRequestSchema.parse(input);
      // Sources are transformed from string array to object array
      // lang defaults to "en" and is applied to web source
      expect(result.sources).toEqual([
        {
          type: "web",
          tbs: undefined,
          filter: undefined,
          lang: "en", // Default lang is applied
          country: "us",
          location: undefined,
        },
        {
          type: "images",
        },
      ]);
    });

    it("should accept search request with advanced sources format", () => {
      const input: SearchRequestInput = {
        query: "test",
        sources: [
          {
            type: "web",
            tbs: "qdr:d",
            filter: "active",
            lang: "en",
            country: "us",
            location: "New York",
          },
          {
            type: "images",
          },
        ],
      };

      const result = searchRequestSchema.parse(input);
      expect(result.sources).toBeDefined();
      expect(Array.isArray(result.sources)).toBe(true);
    });

    it("should accept search request with simple categories array", () => {
      const input: SearchRequestInput = {
        query: "test",
        categories: ["github", "research"],
      };

      const result = searchRequestSchema.parse(input);
      // Categories are transformed from string array to object array
      expect(result.categories).toEqual([
        { type: "github" },
        { type: "research" },
      ]);
    });

    it("should accept search request with advanced categories format", () => {
      const input: SearchRequestInput = {
        query: "test",
        categories: [
          {
            type: "github",
          },
          {
            type: "research",
          },
          {
            type: "pdf",
          },
        ],
      };

      const result = searchRequestSchema.parse(input);
      expect(result.categories).toBeDefined();
      expect(Array.isArray(result.categories)).toBe(true);
    });

    it("should reject limit exceeding 100", () => {
      const input: SearchRequestInput = {
        query: "test",
        limit: 150,
      };

      expect(() => searchRequestSchema.parse(input)).toThrow();
    });

    it("should accept limit within valid range", () => {
      const input: SearchRequestInput = {
        query: "test",
        limit: 50,
      };

      const result = searchRequestSchema.parse(input);
      expect(result.limit).toBe(50);
    });

    it("should handle enterprise array", () => {
      const input: SearchRequestInput = {
        query: "test",
        enterprise: ["default", "zdr"],
      };

      const result = searchRequestSchema.parse(input);
      expect(result.enterprise).toEqual(["default", "zdr"]);
    });
  });

  describe("Type inference", () => {
    it("should correctly infer ScrapeRequest type", () => {
      const result: ScrapeRequest = scrapeRequestSchema.parse({
        url: "https://example.com",
      });

      expect(typeof result.url).toBe("string");
      expect(typeof result.origin).toBe("string");
      expect(Array.isArray(result.formats)).toBe(true);
    });

    it("should correctly infer ExtractRequest type", () => {
      const result: ExtractRequest = extractRequestSchema.parse({
        urls: ["https://example.com"],
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      });

      expect(Array.isArray(result.urls)).toBe(true);
    });

    it("should correctly infer CrawlRequest type", () => {
      const result: CrawlRequest = crawlRequestSchema.parse({
        url: "https://example.com",
      });

      expect(typeof result.url).toBe("string");
      expect(typeof result.limit).toBe("number");
      expect(result.scrapeOptions).toBeDefined();
    });

    it("should correctly infer MapRequest type", () => {
      const result: MapRequest = mapRequestSchema.parse({
        url: "https://example.com",
      });

      expect(typeof result.url).toBe("string");
      expect(typeof result.limit).toBe("number");
    });

    it("should correctly infer BatchScrapeRequest type", () => {
      const result: BatchScrapeRequest = batchScrapeRequestSchema.parse({
        urls: ["https://example.com"],
      });

      expect(Array.isArray(result.urls)).toBe(true);
      expect(result.urls.length).toBeGreaterThan(0);
    });

    it("should correctly infer SearchRequest type", () => {
      const result: SearchRequest = searchRequestSchema.parse({
        query: "test",
      });

      expect(typeof result.query).toBe("string");
      expect(typeof result.limit).toBe("number");
    });
  });

  describe("scrapeOptions schema", () => {
    it("should accept valid scrape options", () => {
      const input = {
        formats: [{ type: "markdown" }, { type: "html" }],
        onlyMainContent: false,
        waitFor: 1000,
      };

      const result = scrapeOptions.parse(input);
      expect(result.formats).toHaveLength(2);
      expect(result.onlyMainContent).toBe(false);
      expect(result.waitFor).toBe(1000);
    });

    it("should reject invalid actions wait time", () => {
      const input = {
        formats: [{ type: "markdown" }],
        waitFor: 0,
        actions: Array.from({ length: 100 }, () => ({
          type: "wait" as const,
          milliseconds: 1000,
        })),
      };

      expect(() => scrapeOptions.parse(input)).toThrow(
        "Total wait time (waitFor + wait actions) cannot exceed",
      );
    });
  });

  describe("Edge cases", () => {
    it("should handle URL without protocol (should add http://)", () => {
      const input = {
        url: "example.com",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.url).toMatch(/^https?:\/\//);
    });

    it("should handle undefined integration (optional field)", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
      };

      const result = scrapeRequestSchema.parse(input);
      // Integration transform converts undefined/falsy to null
      expect(result.integration).toBeNull();
    });

    it("should handle changeTracking format timeout transformation", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          { type: "markdown" },
          {
            type: "changeTracking",
            schema: {
              type: "object",
              properties: {
                changes: { type: "array" },
              },
            },
          },
        ],
        timeout: 30000,
        proxy: "basic", // Use basic proxy to avoid auto/stealth timeout transformation
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.timeout).toBe(60000); // Should be transformed
      expect(result.waitFor).toBeGreaterThanOrEqual(5000); // Should be at least 5000
    });

    it("should handle json format timeout transformation", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          {
            type: "json",
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
            },
          },
        ],
        timeout: 30000,
        proxy: "basic", // Use basic proxy to avoid auto/stealth timeout transformation
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.timeout).toBe(60000); // Should be transformed
    });

    it("should handle changeTrackingOptions with null tag", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: [
          { type: "markdown" },
          {
            type: "changeTracking",
            tag: null,
          },
        ],
      };

      const result = scrapeRequestSchema.parse(input);
      const changeTracking = result.formats.find(
        f => typeof f === "object" && f.type === "changeTracking",
      );
      expect((changeTracking as any).tag).toBeNull();
    });

    it("should handle minAge and maxAge", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        minAge: 1000,
        maxAge: 5000,
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.minAge).toBe(1000);
      expect(result.maxAge).toBe(5000);
    });

    it("should reject negative minAge", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        minAge: -1,
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
    });

    it("should reject negative maxAge", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        maxAge: -1,
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
    });
  });
});
