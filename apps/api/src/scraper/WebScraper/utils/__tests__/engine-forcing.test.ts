import { initializeEngineForcing, getEngineForUrl } from "../engine-forcing";
import { config } from "../../../../config";
describe("Engine Forcing", () => {
  beforeEach(() => {
    delete config.FORCED_ENGINE_DOMAINS;
  });

  describe("initializeEngineForcing", () => {
    it("should initialize with empty mappings when env var is not set", () => {
      initializeEngineForcing();
      expect(getEngineForUrl("https://example.com")).toBeUndefined();
    });

    it("should initialize with empty mappings when env var is empty", () => {
      config.FORCED_ENGINE_DOMAINS = "";
      initializeEngineForcing();
      expect(getEngineForUrl("https://example.com")).toBeUndefined();
    });

    it("should parse valid JSON mappings", () => {
      config.FORCED_ENGINE_DOMAINS = JSON.stringify({
        "example.com": "playwright",
      });
      initializeEngineForcing();
      expect(getEngineForUrl("https://example.com")).toBe("playwright");
    });

    it("should handle invalid JSON gracefully", () => {
      config.FORCED_ENGINE_DOMAINS = "invalid json";
      initializeEngineForcing();
      expect(getEngineForUrl("https://example.com")).toBeUndefined();
    });
  });

  describe("getEngineForUrl", () => {
    beforeEach(() => {
      config.FORCED_ENGINE_DOMAINS = JSON.stringify({
        "example.com": "playwright",
        "test.com": "fetch",
        "*.subdomain.com": "fire-engine;chrome-cdp",
        "google.com": ["fire-engine;chrome-cdp", "playwright"],
      });
      initializeEngineForcing();
    });

    it("should return undefined for non-matching domains", () => {
      expect(getEngineForUrl("https://nomatch.com")).toBeUndefined();
    });

    it("should match exact domain", () => {
      expect(getEngineForUrl("https://example.com")).toBe("playwright");
      expect(getEngineForUrl("https://test.com")).toBe("fetch");
    });

    it("should match subdomains of exact domain", () => {
      expect(getEngineForUrl("https://www.example.com")).toBe("playwright");
      expect(getEngineForUrl("https://api.example.com")).toBe("playwright");
    });

    it("should match wildcard patterns", () => {
      expect(getEngineForUrl("https://api.subdomain.com")).toBe(
        "fire-engine;chrome-cdp",
      );
      expect(getEngineForUrl("https://www.subdomain.com")).toBe(
        "fire-engine;chrome-cdp",
      );
    });

    it("should not match wildcard pattern for base domain", () => {
      expect(getEngineForUrl("https://subdomain.com")).toBeUndefined();
    });

    it("should return array of engines when configured", () => {
      const result = getEngineForUrl("https://google.com");
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(["fire-engine;chrome-cdp", "playwright"]);
    });

    it("should handle URLs with paths and query strings", () => {
      expect(getEngineForUrl("https://example.com/path?query=1")).toBe(
        "playwright",
      );
    });

    it("should be case-insensitive", () => {
      expect(getEngineForUrl("https://EXAMPLE.COM")).toBe("playwright");
      expect(getEngineForUrl("https://Example.Com/path")).toBe("playwright");
    });

    it("should handle invalid URLs gracefully", () => {
      expect(getEngineForUrl("not-a-url")).toBeUndefined();
      expect(getEngineForUrl("")).toBeUndefined();
    });

    it("should throw error if not initialized", () => {
      delete config.FORCED_ENGINE_DOMAINS;
      expect(() => {
        const {
          getEngineForUrl: freshGetEngineForUrl,
        } = require("../engine-forcing");
        freshGetEngineForUrl("https://example.com");
      }).toThrow("Engine forcing not initialized");
    });
  });
});
