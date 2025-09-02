import { describe, it, expect } from "@jest/globals";
import { scrapeOptions } from "../../../controllers/v1/types";

describe("iframe selector transformation", () => {
  describe("Zod schema transformation", () => {
    it("should transform includeTags through schema", () => {
      const input = { includeTags: ["iframe", "iframe.video", "div.content"] };
      const result = scrapeOptions.parse(input);
      expect(result.includeTags).toEqual([
        'div[data-original-tag="iframe"]',
        'div[data-original-tag="iframe"].video',
        "div.content",
      ]);
    });

    it("should transform excludeTags through schema", () => {
      const input = { excludeTags: ["iframe", "iframe#main-video"] };
      const result = scrapeOptions.parse(input);
      expect(result.excludeTags).toEqual([
        'div[data-original-tag="iframe"]',
        'div[data-original-tag="iframe"]#main-video',
      ]);
    });

    it("should handle empty arrays", () => {
      const input = { includeTags: [], excludeTags: [] };
      const result = scrapeOptions.parse(input);
      expect(result.includeTags).toEqual([]);
      expect(result.excludeTags).toEqual([]);
    });

    it("should handle missing optional fields", () => {
      const input = {};
      const result = scrapeOptions.parse(input);
      expect(result.includeTags).toBeUndefined();
      expect(result.excludeTags).toBeUndefined();
    });

    it("should handle complex selectors with combinators", () => {
      const input = {
        includeTags: [
          "div iframe",
          "iframe > div",
          "div + iframe",
          "iframe ~ p",
        ],
        excludeTags: ["iframe, iframe.video"],
      };
      const result = scrapeOptions.parse(input);
      expect(result.includeTags).toEqual([
        'div div[data-original-tag="iframe"]',
        'div[data-original-tag="iframe"] > div',
        'div + div[data-original-tag="iframe"]',
        'div[data-original-tag="iframe"] ~ p',
      ]);
      expect(result.excludeTags).toEqual([
        'div[data-original-tag="iframe"], div[data-original-tag="iframe"].video',
      ]);
    });

    it("should not transform partial matches", () => {
      const input = {
        includeTags: ["div.iframe-container", "iframe-wrapper", "my-iframe"],
        excludeTags: [
          "iframe.embed-responsive-item",
          '.container iframe[src*="youtube.com"]',
        ],
      };
      const result = scrapeOptions.parse(input);
      expect(result.includeTags).toEqual([
        "div.iframe-container",
        "iframe-wrapper",
        "my-iframe",
      ]);
      expect(result.excludeTags).toEqual([
        'div[data-original-tag="iframe"].embed-responsive-item',
        '.container div[data-original-tag="iframe"][src*="youtube.com"]',
      ]);
    });
  });
});
