import { Identity, idmux, scrapeTimeout, scrape } from "./lib";
import crypto from "crypto";

describe("V2 Scrape Default maxAge", () => {
  if (!process.env.TEST_SUITE_SELF_HOSTED) {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "v2-scrape-default-maxage",
        concurrency: 100,
        credits: 1000000,
      });
    }, 10000);

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
        await new Promise(resolve => setTimeout(resolve, 20000));

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
      scrapeTimeout * 2 + 20000,
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
        await new Promise(resolve => setTimeout(resolve, 20000));

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
      scrapeTimeout * 2 + 20000,
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
            maxAge: 3600000, // 1 hour in milliseconds
          },
          identity,
        );

        expect(data1).toBeDefined();
        expect(data1.metadata.cacheState).toBe("miss");

        // Wait for index to be populated
        await new Promise(resolve => setTimeout(resolve, 20000));

        // Second scrape with same maxAge should hit cache
        const data2 = await scrape(
          {
            url,
            maxAge: 3600000, // 1 hour in milliseconds
          },
          identity,
        );

        expect(data2).toBeDefined();
        expect(data2.metadata.cacheState).toBe("hit");
        expect(data2.metadata.cachedAt).toBeDefined();
      },
      scrapeTimeout * 2 + 20000,
    );
  } else {
    it("mocked", () => {
      expect(true).toBe(true);
    });
  }
});
