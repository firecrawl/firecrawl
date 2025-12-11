import { z } from "zod";
import {
  scrapeRequestSchema,
  scrapeOptions,
  extractRequestSchema,
  crawlRequestSchema,
  mapRequestSchema,
  batchScrapeRequestSchema,
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
} from "../../../controllers/v1/types";

describe("V1 Types Validation", () => {
  describe("scrapeRequestSchema", () => {
    it("should accept valid minimal scrape request", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.origin).toBe("api");
      expect(result.timeout).toBe(30000);
      expect(result.formats).toEqual(["markdown"]);
    });

    it("should accept valid scrape request with all optional fields", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 1000,
        mobile: true,
        parsePDF: false,
        skipTlsVerification: true,
        removeBase64Images: false,
        fastMode: true,
        blockAds: false,
        proxy: "stealth",
        maxAge: 3600000,
        storeInCache: false,
        origin: "custom",
        timeout: 60000,
        zeroDataRetention: true,
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.formats).toEqual(["markdown", "html"]);
      expect(result.origin).toBe("custom");
      expect(result.timeout).toBe(60000);
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

    it("should reject invalid format combination (screenshot and screenshot@fullPage)", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["screenshot", "screenshot@fullPage"],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "You may only specify either screenshot or screenshot@fullPage",
      );
    });

    it("should reject changeTracking without markdown", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["changeTracking"],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "The changeTracking format requires the markdown format to be specified as well",
      );
    });

    it("should accept changeTracking with markdown", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["markdown", "changeTracking"],
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toContain("markdown");
      expect(result.formats).toContain("changeTracking");
    });

    it("should reject extract format without extract options", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["extract"],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "When 'extract' or 'json' format is specified, corresponding options must be provided",
      );
    });

    it("should accept extract format with extract options", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["extract"],
        extract: {
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toContain("extract");
      expect(result.extract).toBeDefined();
      expect(result.timeout).toBe(60000); // Should be transformed from 30000
    });

    it("should reject json format without jsonOptions", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["json"],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "When 'extract' or 'json' format is specified, corresponding options must be provided",
      );
    });

    it("should accept json format with jsonOptions", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["json"],
        jsonOptions: {
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.formats).toContain("json");
      expect(result.formats).toContain("extract"); // Should be added by transform
      expect(result.jsonOptions).toBeDefined();
      expect(result.timeout).toBe(60000); // Should be transformed from 30000
    });

    it("should reject extract options without extract format", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        extract: {
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "When 'extract' or 'json' format is specified, corresponding options must be provided",
      );
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

    it("should reject both agent and jsonOptions with fire-1 model", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["json"],
        agent: {
          model: "fire-1",
          prompt: "test",
        },
        jsonOptions: {
          agent: {
            model: "fire-1",
            prompt: "test",
          },
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "You may only specify the FIRE-1 model in agent or jsonOptions.agent, but not both",
      );
    });

    it("should transform jsonOptions to extract when json format is used", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["json"],
        jsonOptions: {
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.extract).toBeDefined();
      expect(result.jsonOptions).toBeDefined();
    });

    it("should apply default values correctly", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.origin).toBe("api");
      expect(result.timeout).toBe(30000);
      expect(result.formats).toEqual(["markdown"]);
      expect(result.onlyMainContent).toBe(true);
      expect(result.waitFor).toBe(0);
      expect(result.mobile).toBe(false);
      expect(result.parsePDF).toBe(true);
      expect(result.removeBase64Images).toBe(true);
      expect(result.fastMode).toBe(false);
      expect(result.blockAds).toBe(true);
      expect(result.proxy).toBe("basic");
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
      expect(result.timeout).toBe(60000);
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
      expect(result.maxDepth).toBe(10);
      expect(result.scrapeOptions).toBeDefined();
    });

    it("should accept valid crawl request with all crawler options", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
        includePaths: ["/blog"],
        excludePaths: ["/admin"],
        maxDepth: 5,
        maxDiscoveryDepth: 10,
        limit: 5000,
        crawlEntireDomain: true,
        allowExternalLinks: true,
        allowSubdomains: true,
        ignoreRobotsTxt: true,
        ignoreSitemap: true,
        deduplicateSimilarURLs: false,
        ignoreQueryParameters: true,
        regexOnFullURL: true,
        delay: 1000,
        scrapeOptions: {
          formats: ["markdown"],
        },
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.url).toBe("https://example.com");
      expect(result.maxDepth).toBe(5);
      expect(result.crawlEntireDomain).toBe(true);
      expect(result.allowBackwardLinks).toBe(true); // Should be transformed
    });

    it("should reject URL depth exceeding maxDepth", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com/level1/level2/level3/level4/level5/level6/level7/level8/level9/level10/level11",
        maxDepth: 5,
      };

      expect(() => crawlRequestSchema.parse(input)).toThrow(
        "URL depth exceeds the specified maxDepth",
      );
    });

    it("should transform crawlEntireDomain to allowBackwardLinks", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
        crawlEntireDomain: true,
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.allowBackwardLinks).toBe(true);
    });

    it("should apply default scrapeOptions when not provided", () => {
      const input: CrawlRequestInput = {
        url: "https://example.com",
      };

      const result = crawlRequestSchema.parse(input);
      expect(result.scrapeOptions).toBeDefined();
      expect(result.scrapeOptions.formats).toEqual(["markdown"]);
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
  });

  describe("batchScrapeRequestSchema", () => {
    it("should accept valid batch scrape request", () => {
      const input: BatchScrapeRequestInput = {
        urls: ["https://example.com", "https://example.org"],
      };

      const result = batchScrapeRequestSchema.parse(input);
      expect(result.urls).toHaveLength(2);
      expect(result.origin).toBe("api");
      expect(result.ignoreInvalidURLs).toBe(false);
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

  describe("Type inference", () => {
    it("should correctly infer ScrapeRequest type", () => {
      const result: ScrapeRequest = scrapeRequestSchema.parse({
        url: "https://example.com",
      });

      // TypeScript should enforce these types
      expect(typeof result.url).toBe("string");
      expect(typeof result.origin).toBe("string");
      expect(typeof result.timeout).toBe("number");
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
      expect(typeof result.timeout).toBe("number");
    });

    it("should correctly infer CrawlRequest type", () => {
      const result: CrawlRequest = crawlRequestSchema.parse({
        url: "https://example.com",
      });

      expect(typeof result.url).toBe("string");
      expect(typeof result.maxDepth).toBe("number");
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
  });

  describe("scrapeOptions schema", () => {
    it("should accept valid scrape options", () => {
      const input = {
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 1000,
      };

      const result = scrapeOptions.parse(input);
      expect(result.formats).toEqual(["markdown", "html"]);
      expect(result.onlyMainContent).toBe(false);
      expect(result.waitFor).toBe(1000);
    });

    it("should reject invalid actions wait time", () => {
      const input = {
        formats: ["markdown"],
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
        formats: ["markdown", "changeTracking"],
        timeout: 30000,
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.timeout).toBe(60000); // Should be transformed
      expect(result.waitFor).toBeGreaterThanOrEqual(5000); // Should be at least 5000
    });

    it("should handle agent timeout transformation", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        agent: {
          model: "fire-1",
          prompt: "test",
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.timeout).toBe(300000); // Should be transformed
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

    it("should handle location schema with special country codes", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        location: {
          country: "us-generic",
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.location?.country).toBe("us-generic");
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

    it("should handle geolocation schema (deprecated) with valid country", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        geolocation: {
          country: "us",
          languages: ["en"],
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.geolocation?.country).toBe("US"); // Should be transformed to uppercase
      expect(result.geolocation?.languages).toEqual(["en"]);
    });

    it("should reject geolocation schema with invalid country", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        geolocation: {
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

    it("should reject wait action without milliseconds or selector", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        actions: [
          {
            type: "wait",
          },
        ],
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow();
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

    it("should handle changeTrackingOptions with valid schema", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["markdown", "changeTracking"],
        changeTrackingOptions: {
          schema: {
            type: "object",
            properties: {
              changes: { type: "array" },
            },
          },
          modes: ["json"],
          tag: "test-tag",
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.changeTrackingOptions).toBeDefined();
      expect(result.changeTrackingOptions?.modes).toEqual(["json"]);
      expect(result.changeTrackingOptions?.tag).toBe("test-tag");
    });

    it("should handle changeTrackingOptions with null tag", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["markdown", "changeTracking"],
        changeTrackingOptions: {
          tag: null,
        },
      };

      const result = scrapeRequestSchema.parse(input);
      expect(result.changeTrackingOptions?.tag).toBeNull();
    });

    it("should reject invalid changeTrackingOptions schema", () => {
      const input: ScrapeRequestInput = {
        url: "https://example.com",
        formats: ["markdown", "changeTracking"],
        changeTrackingOptions: {
          schema: {
            type: "invalid",
          },
        },
      };

      expect(() => scrapeRequestSchema.parse(input)).toThrow(
        "Invalid JSON schema",
      );
    });
  });
});
