import { describeIf, TEST_PRODUCTION } from "../lib";
import type { Identity } from "./lib";
import { idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";
import crypto from "node:crypto";

describeIf(TEST_PRODUCTION)("V2 Scrape Default maxAge", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-default-maxage",
      concurrency: 100,
      credits: 1_000_000,
    });
  }, 10_000);

  test(
    "should use default maxAge of 4 hours when not specified",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20_000);
      });

      // Second scrape should hit cache with default maxAge
      const data2 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBe("hit");
      expect(data2.metadata.cachedAt).toBeDefined();
    },
    scrapeTimeout * 2 + 20_000,
  );

  test(
    "should respect explicitly set maxAge of 0",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20_000);
      });

      // Second scrape with maxAge=0 should miss cache
      const data2 = await scrape(
        {
          url,
          maxAge: 0,
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBeUndefined();
    },
    scrapeTimeout * 2 + 20_000,
  );

  test(
    "should respect custom maxAge value",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
          maxAge: 3_600_000, // 1 hour in milliseconds
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20_000);
      });

      // Second scrape with same maxAge should hit cache
      const data2 = await scrape(
        {
          url,
          maxAge: 3_600_000, // 1 hour in milliseconds
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBe("hit");
      expect(data2.metadata.cachedAt).toBeDefined();
    },
    scrapeTimeout * 2 + 20_000,
  );

  test(
    "should return error if cached data does not meet minAge requirement",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20_000);
      });

      // Second scrape with minAge should fail
      const response = await scrapeRaw(
        {
          url,
          minAge: 60_000,
        },
        identity,
      );

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("SCRAPE_NO_CACHED_DATA");
    },
    scrapeTimeout * 2 + 20_000,
  );

  test(
    "should return cached data if it meets minAge requirement",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated and for data to age
      await new Promise<void>(resolve => {
        setTimeout(resolve, 35_000);
      });

      // Second scrape with minAge should hit cache
      const data2 = await scrape(
        {
          url,
          minAge: 30_000,
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBe("hit");
      expect(data2.metadata.cachedAt).toBeDefined();
    },
    scrapeTimeout * 2 + 35_000,
  );
});
