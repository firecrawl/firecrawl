jest.mock("@mendable/firecrawl-rs", () => ({
  transformHtml: jest
    .fn()
    .mockRejectedValue(new Error("force Cheerio fallback")),
}));

import { htmlTransform } from "../removeUnwantedElements";
import { load } from "cheerio";

const baseUrl = "https://example.com/page.html";
const defaultOptions = {} as any;

describe("htmlTransform", () => {
  describe("img[srcset] preservation and src derivation", () => {
    it("preserves srcset attribute in output when img has srcset", async () => {
      const html = `
        <html><body>
          <img 
            srcset="small.jpg 480w, medium.jpg 800w, large.jpg 1200w" 
            alt="Responsive image"
          >
        </body></html>
      `;
      const result = await htmlTransform(html, baseUrl, defaultOptions);
      const $ = load(result);

      const img = $("img");
      expect(img.length).toBe(1);

      expect(img.attr("srcset")).toBe(
        "small.jpg 480w, medium.jpg 800w, large.jpg 1200w",
      );
    });

    it("derives src from the largest width descriptor when no original src", async () => {
      const inputHtml = `
        <html><body>
          <img srcset="small.jpg 480w, large.jpg 1200w" alt="Test">
        </body></html>
      `;

      const result = await htmlTransform(inputHtml, baseUrl, defaultOptions);
      const $ = load(result);

      const img = $("img");
      expect(img.attr("src")).toBe("https://example.com/large.jpg");
      expect(img.attr("srcset")).toContain("small.jpg 480w");
    });

    it("derives src preferring highest DPR when using x-descriptors", async () => {
      const inputHtml = `
        <html><body>
          <img srcset="lo-res.jpg 1x, med-res.jpg 2x, hi-res.jpg 3x" alt="DPR test">
        </body></html>
      `;

      const result = await htmlTransform(inputHtml, baseUrl, defaultOptions);
      const $ = load(result);

      const img = $("img");
      expect(img.attr("src")).toBe("https://example.com/hi-res.jpg");
    });

    it("sets src from srcset when original src is missing", async () => {
      const inputHtml = `
        <html><body>
          <img srcset="only-srcset.jpg 1x" alt="Only srcset">
        </body></html>
      `;

      const result = await htmlTransform(inputHtml, baseUrl, defaultOptions);
      const $ = load(result);

      const img = $("img");
      expect(img.attr("src")).toBe("https://example.com/only-srcset.jpg");
      expect(img.attr("srcset")).toBe("only-srcset.jpg 1x");
    });

    it("overrides src with the best candidate from srcset when srcset is present (even if src exists)", async () => {
      const inputHtml = `
        <html><body>
          <img src="already-good.jpg" srcset="better.jpg 2x, worse.jpg 1x" alt="Override src">
        </body></html>
      `;

      const result = await htmlTransform(inputHtml, baseUrl, defaultOptions);
      const $ = load(result);

      const img = $("img");

      expect(img.attr("src")).toBe("https://example.com/better.jpg");
      expect(img.attr("srcset")).toContain("better.jpg 2x, worse.jpg 1x");
    });

    it("handles malformed srcset gracefully (preserves as-is)", async () => {
      const inputHtml = `
        <html><body>
          <img srcset="invalid, nonsense 999w" alt="Bad">
        </body></html>
      `;

      const result = await htmlTransform(inputHtml, baseUrl, defaultOptions);
      const $ = load(result);

      const img = $("img");
      expect(img.attr("srcset")).toContain("invalid, nonsense 999w");
    });
  });
});
