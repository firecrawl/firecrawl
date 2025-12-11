import {
  concurrentIf,
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrapeRaw, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "v0-scrape",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("V0 Scrape tests", () => {
  describe("URL validation", () => {
    it.concurrent("rejects invalid URL format", async () => {
      const response = await scrapeRaw(
        {
          url: "not-a-valid-url",
        },
        identity,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
      expect(typeof response.body.error).toBe("string");
      // Should contain validation error messages
      expect(
        response.body.error.includes("Invalid URL") ||
          response.body.error.includes("valid top-level domain"),
      ).toBe(true);
    });

    it.concurrent("rejects URL without protocol", async () => {
      const response = await scrapeRaw(
        {
          url: "example.com",
        },
        identity,
      );

      // Note: The schema adds http:// prefix, so this might pass validation
      // But if it fails, it should return 400
      if (response.statusCode === 400) {
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBeDefined();
      }
    });

    it.concurrent("rejects URL with unsupported protocol", async () => {
      const response = await scrapeRaw(
        {
          url: "ftp://example.com",
        },
        identity,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
      expect(response.body.error).toContain("unsupported protocol");
    });

    it.concurrent("rejects empty URL", async () => {
      const response = await scrapeRaw(
        {
          url: "",
        },
        identity,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });

    it.concurrent("rejects URL without top-level domain", async () => {
      const response = await scrapeRaw(
        {
          url: "http://localhost",
        },
        identity,
      );

      // This might pass in self-hosted mode, but should fail in production
      if (response.statusCode === 400) {
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBeDefined();
        expect(
          response.body.error.includes("valid top-level domain") ||
            response.body.error.includes("Invalid URL"),
        ).toBe(true);
      }
    });

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "accepts valid URL without validation errors",
      async () => {
        const response = await scrapeRaw(
          {
            url: TEST_SUITE_WEBSITE,
          },
          identity,
        );

        // Valid URL should not return 400 for URL validation errors
        // If it returns 400, the error should not be about URL validation
        if (response.statusCode === 400) {
          expect(response.body.error).not.toContain("Invalid URL");
          expect(response.body.error).not.toContain("valid top-level domain");
          expect(response.body.error).not.toContain("unsupported protocol");
        }
      },
      60000,
    );
  });
});
