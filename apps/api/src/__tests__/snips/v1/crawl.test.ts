import {
  asyncCrawl,
  asyncCrawlWaitForFinish,
  crawl,
  crawlOngoing,
  crawlStart,
  Identity,
  idmux,
  scrapeTimeout,
} from "./lib";
import request from "supertest";
import { it, expect } from "vitest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_API_URL,
  TEST_SUITE_WEBSITE,
} from "../lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "crawl",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("UUID validation", () => {
  it.concurrent("rejects malformed UUIDs for crawl status", async () => {
    const response = await request(TEST_API_URL)
      .get("/v1/crawl/not-a-uuid")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .send();

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe(
      "Invalid job ID format. Job ID must be a valid UUID.",
    );
  });

  it.concurrent("rejects malformed UUIDs for batch scrape status", async () => {
    const response = await request(TEST_API_URL)
      .get("/v1/batch/scrape/not-a-uuid")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .send();

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe(
      "Invalid job ID format. Job ID must be a valid UUID.",
    );
  });
});

describeIf(ALLOW_TEST_SUITE_WEBSITE)("Crawl tests", () => {
  const base = TEST_SUITE_WEBSITE;
  const baseUrl = new URL(base);
  const baseDomain = baseUrl.hostname;

  it(
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

  it(
    "works with ignoreSitemap: true",
    async () => {
      const results = await crawl(
        {
          url: base,
          limit: 10,
          ignoreSitemap: true,
        },
        identity,
      );

      expect(results.completed).toBeGreaterThan(0);
    },
    10 * scrapeTimeout,
  );

  it(
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
  // it.concurrent(
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
  //       expect(res.data[0].metadata.sourceURL).toBe(base);
  //     }
  //   },
  //   10 * scrapeTimeout,
  // );

  it(
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

  it.concurrent(
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
    3 * scrapeTimeout,
  );

  // TEMP: Flaky
  // it.concurrent("discovers URLs properly when origin is not included", async () => {
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
  // it.concurrent("discovers URLs properly when maxDiscoveryDepth is provided", async () => {
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

  it.concurrent(
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

  it.concurrent(
    "crawlEntireDomain takes precedence over allowBackwardLinks",
    async () => {
      const res = await crawl(
        {
          url: base,
          allowBackwardLinks: false,
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

  it.concurrent(
    "backward compatibility - allowBackwardLinks still works",
    async () => {
      const res = await crawl(
        {
          url: base,
          allowBackwardLinks: true,
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

  it.concurrent(
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

  it.concurrent(
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

  it.concurrent(
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

  // FIXME: not working
  // it.concurrent("rejects crawl when URL depth exceeds maxDepth", async () => {
  //   const response = await crawlStart(
  //     {
  //       url: base,
  //       maxDepth: 2,
  //       limit: 5,
  //     },
  //     identity,
  //   );

  //   expect(response.statusCode).toBe(400);
  //   expect(response.body.success).toBe(false);
  //   expect(response.body.error).toBe("Bad Request");
  //   expect(response.body.details).toBeDefined();
  //   expect(response.body.details[0].message).toBe(
  //     "URL depth exceeds the specified maxDepth",
  //   );
  //   expect(response.body.details[0].path).toEqual(["url"]);
  // });

  it.concurrent("accepts crawl when URL depth equals maxDepth", async () => {
    const response = await crawlStart(
      {
        url: base,
        maxDepth: 2,
        limit: 5,
      },
      identity,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(typeof response.body.id).toBe("string");
  });

  it.concurrent(
    "accepts crawl when URL depth is less than maxDepth",
    async () => {
      const response = await crawlStart(
        {
          url: base,
          maxDepth: 5,
          limit: 5,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(typeof response.body.id).toBe("string");
    },
  );

  it.concurrent(
    "filters out non-web protocol links (telnet, ftp, ssh, file, mailto)",
    async () => {
      const res = await crawl(
        {
          url: base,
          limit: 10,
        },
        identity,
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.completed).toBeGreaterThan(0);
        for (const page of res.data) {
          const url = page.metadata.url ?? page.metadata.sourceURL!;
          expect(url).not.toMatch(/^(mailto|tel|telnet|ftp|ftps|ssh|file):/);
          expect(url).toMatch(/^https?:/);
        }
      }
    },
    10 * scrapeTimeout,
  );
});
