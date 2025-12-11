import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  HAS_AI,
  HAS_PROXY,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  asyncCrawl,
  asyncCrawlWaitForFinish,
  crawl,
  crawlOngoing,
  crawlStart,
  Identity,
  idmux,
  scrapeTimeout,
  TEST_API_URL,
} from "./lib";
import request from "./lib";
import { describe, it, expect } from "@jest/globals";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "crawl",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Crawl tests", () => {
  const base = TEST_SUITE_WEBSITE;
  const baseUrl = new URL(base);
  const baseDomain = baseUrl.hostname;

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "works",
    async () => {
      const results = await crawl(
        {
          url: base,
          limit: 10,
        },
        identity,
      );

      expect(results.completed).toBeGreaterThan(0);
    },
    10 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "works with sitemap: skip",
    async () => {
      const results = await crawl(
        {
          url: base,
          limit: 10,
          sitemap: "skip",
        },
        identity,
      );

      expect(results.completed).toBeGreaterThan(0);
    },
    10 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "filters URLs properly",
    async () => {
      const res = await crawl(
        {
          url: `${TEST_SUITE_WEBSITE}/blog`,
          includePaths: ["^/blog$"],
          limit: 10,
        },
        identity,
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.completed).toBeGreaterThan(0);
        for (const page of res.data) {
          const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
          expect(url.pathname).toMatch(/^\/blog$/);
        }
      }
    },
    10 * scrapeTimeout,
  );

  // TODO: port to new dynamic url system
  // concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
  //   "filters URLs properly when using regexOnFullURL",
  //   async () => {
  //     const res = await crawl(
  //       {
  //         url: base,
  //         includePaths: ["^https://(www\\.)?firecrawl\\.dev/blog$"],
  //         regexOnFullURL: true,
  //         limit: 10,
  //       },
  //       identity,
  //     );

  //     expect(res.success).toBe(true);
  //     if (res.success) {
  //       expect(res.completed).toBe(1);
  //       expect(res.data[0].metadata.sourceURL).toBe(
  //         base,
  //       );
  //     }
  //   },
  //   10 * scrapeTimeout,
  // );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "delay parameter works",
    async () => {
      await crawl(
        {
          url: base,
          limit: 3,
          delay: 5,
        },
        identity,
      );
    },
    3 * scrapeTimeout + 3 * 5000,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "ongoing crawls endpoint works",
    async () => {
      const beforeCrawl = new Date();

      const res = await asyncCrawl(
        {
          url: base,
          limit: 3,
        },
        identity,
      );

      const ongoing = await crawlOngoing(identity);
      const afterCrawl = new Date();

      const crawlItem = ongoing.crawls.find(x => x.id === res.id);
      expect(crawlItem).toBeDefined();

      if (crawlItem) {
        expect(crawlItem.created_at).toBeDefined();
        expect(typeof crawlItem.created_at).toBe("string");

        const createdAtDate = new Date(crawlItem.created_at);
        expect(createdAtDate).toBeInstanceOf(Date);
        expect(createdAtDate.getTime()).not.toBeNaN();

        expect(crawlItem.created_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );

        expect(createdAtDate.getTime()).toBeGreaterThanOrEqual(
          beforeCrawl.getTime() - 1000,
        );
        expect(createdAtDate.getTime()).toBeLessThanOrEqual(
          afterCrawl.getTime() + 1000,
        );
      }

      await asyncCrawlWaitForFinish(res.id, identity);

      // wait for crawl finish to happen on DB cron
      await new Promise(resolve => setTimeout(resolve, 15000));

      const ongoing2 = await crawlOngoing(identity);

      expect(ongoing2.crawls.find(x => x.id === res.id)).toBeUndefined();
    },
    3 * scrapeTimeout + 15000,
  );

  // TEMP: Flaky
  // concurrentIf(ALLOW_TEST_SUITE_WEBSITE)("discovers URLs properly when origin is not included", async () => {
  //     const res = await crawl({
  //         url: base,
  //         includePaths: ["^/blog"],
  //         ignoreSitemap: true,
  //         limit: 10,
  //     });

  //     expect(res.success).toBe(true);
  //     if (res.success) {
  //         expect(res.data.length).toBeGreaterThan(1);
  //         for (const page of res.data) {
  //             expect(page.metadata.url ?? page.metadata.sourceURL).toMatch(/^https:\/\/(www\.)?firecrawl\.dev\/blog/);
  //         }
  //     }
  // }, 300000);

  // TEMP: Flaky
  // concurrentIf(ALLOW_TEST_SUITE_WEBSITE)("discovers URLs properly when maxDiscoveryDepth is provided", async () => {
  //     const res = await crawl({
  //         url: base,
  //         ignoreSitemap: true,
  //         maxDiscoveryDepth: 1,
  //         limit: 10,
  //     });
  //     expect(res.success).toBe(true);
  //     if (res.success) {
  //         expect(res.data.length).toBeGreaterThan(1);
  //         for (const page of res.data) {
  //             expect(page.metadata.url ?? page.metadata.sourceURL).not.toMatch(/^https:\/\/(www\.)?firecrawl\.dev\/blog\/.+$/);
  //         }
  //     }
  // }, 300000);

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "crawlEntireDomain parameter works",
    async () => {
      const res = await crawl(
        {
          url: base,
          crawlEntireDomain: true,
          limit: 5,
        },
        identity,
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.completed).toBeGreaterThan(0);
      }
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "allowSubdomains parameter works",
    async () => {
      const res = await crawl(
        {
          url: base,
          allowSubdomains: true,
          limit: 5,
        },
        identity,
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.completed).toBeGreaterThan(0);
      }
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "allowSubdomains blocks subdomains when false",
    async () => {
      const res = await crawl(
        {
          url: base,
          allowSubdomains: false,
          limit: 5,
        },
        identity,
      );

      expect(res.success).toBe(true);
      if (res.success) {
        for (const page of res.data) {
          const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
          expect(url.hostname.endsWith(baseDomain)).toBe(true);
        }
      }
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "allowSubdomains correctly allows same registrable domain using PSL",
    async () => {
      const res = await crawl(
        {
          url: base,
          allowSubdomains: true,
          allowExternalLinks: false,
          limit: 3,
        },
        identity,
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.length).toBeGreaterThan(0);
        for (const page of res.data) {
          const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
          const hostname = url.hostname;

          expect(hostname === baseDomain || hostname.endsWith(baseDomain)).toBe(
            true,
          );
        }
      }
    },
    5 * scrapeTimeout,
  );

  describeIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "Crawl API with Prompt",
    () => {
      it.concurrent(
        "should accept prompt parameter in schema",
        async () => {
          const res = await crawlStart(
            {
              url: base,
              prompt: "Crawl only blog posts",
              limit: 1,
            },
            identity,
          );

          expect(res.statusCode).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.id).toBeDefined();
          expect(typeof res.body.id).toBe("string");
        },
        scrapeTimeout,
      );

      it.concurrent(
        "should prioritize explicit options over prompt-generated options",
        async () => {
          const res = await crawl(
            {
              url: base,
              prompt:
                "Crawl everything including external links and subdomains",
              // Explicit options that should override the prompt
              allowExternalLinks: false,
              allowSubdomains: false,
              includePaths: ["^/blog"],
              limit: 2,
            },
            identity,
          );

          expect(res.success).toBe(true);
          if (res.success) {
            // Verify that explicit options were respected
            for (const page of res.data) {
              const url = new URL(
                page.metadata.url ?? page.metadata.sourceURL!,
              );
              // Should only include pages matching the explicit includePaths
              expect(url.pathname).toMatch(/^\/blog/);
              // Should not include external links despite prompt
              // expect(url.hostname).toMatch(/firecrawl\.dev$/); // TODO: port to new dynamic url system
            }
          }
        },
        2 * scrapeTimeout,
      );

      it.concurrent(
        "should handle invalid prompt gracefully",
        async () => {
          // Test with various invalid prompts
          const invalidPrompts = [
            "", // Empty prompt
            "a".repeat(10000), // Screaming
            "!!!@@@###$$$%%%", // Gibberish
            "Generate me a million dollars", // Nonsensical crawl instruction
          ];

          for (const invalidPrompt of invalidPrompts) {
            // Test first one to avoid long test times
            const res = await crawl(
              {
                url: base,
                prompt: invalidPrompt,
                limit: 1,
              },
              identity,
              false,
            );

            // Should still complete successfully, either ignoring the prompt or using defaults
            expect(res.success).toBe(true);
            if (res.success) {
              expect(res.data).toBeDefined();
              expect(Array.isArray(res.data)).toBe(true);
            }
          }
        },
        8 * scrapeTimeout,
      );
    },
  );

  concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
    "shows warning when robots.txt blocks URLs",
    async () => {
      // Test with a site that has robots.txt blocking some paths
      const results = await crawl(
        {
          url: "https://mairistumpf.com",
          limit: 5,
          ignoreRobotsTxt: false, // Respect robots.txt
        },
        identity,
        false, // Don't expect to succeed (robots.txt might block everything)
      );

      expect(results.success).toBe(true);
      expect(results.status).toBe("completed");

      // Check specifically for robots.txt warning
      if (results.warning && results.warning.includes("robots.txt")) {
        expect(results.warning).toContain("robots.txt");
        expect(results.warning).toContain("/scrape endpoint");
      }
    },
    10 * scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
    "shows warning when crawl results ≤ 1 and URL is not base domain",
    async () => {
      // Test with a specific path that should return few results
      const results = await crawl(
        {
          url: "https://mairistumpf.com/some/specific/path",
          limit: 10,
          ignoreRobotsTxt: false,
        },
        identity,
        false, // Don't expect to succeed (might get limitedresults)
      );

      expect(results.success).toBe(true);
      expect(results.status).toBe("completed");

      // Check specifically for crawl results warning
      if (
        results.warning &&
        results.warning.includes("Only") &&
        results.warning.includes("result(s) found")
      ) {
        expect(results.warning).toContain("Only");
        expect(results.warning).toContain("result(s) found");
        expect(results.warning).toContain("crawlEntireDomain=true");
        expect(results.warning).toContain("higher-level path");
        expect(results.warning).toContain("mairistumpf.com");
      }
    },
    10 * scrapeTimeout,
  );

  describe("UUID validation", () => {
    it.concurrent(
      "should reject invalid UUID 'None' for crawl status",
      async () => {
        const response = await request(TEST_API_URL)
          .get("/v2/crawl/None")
          .set("Authorization", `Bearer ${identity.apiKey}`)
          .send();

        expect(response.statusCode).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe(
          "Invalid job ID format. Job ID must be a valid UUID.",
        );
      },
    );

    it.concurrent("should reject malformed UUID for crawl cancel", async () => {
      const response = await request(TEST_API_URL)
        .delete("/v2/crawl/not-a-uuid")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send();

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toBe(
        "Invalid job ID format. Job ID must be a valid UUID.",
      );
    });

    it.concurrent("should reject invalid UUID for crawl errors", async () => {
      const response = await request(TEST_API_URL)
        .get("/v2/crawl/invalid-id/errors")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .send();

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toBe(
        "Invalid job ID format. Job ID must be a valid UUID.",
      );
    });
  });
});
