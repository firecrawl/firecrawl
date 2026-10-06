import request from "supertest";
import {
  describeIf,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  batchScrapeWithConcurrencyTracking,
  crawlWithConcurrencyTracking,
  idmux,
} from "./lib";

const accountConcurrencyLimit = 20;

describeIf(TEST_PRODUCTION)("Concurrency queue and limit", () => {
  const base = TEST_SUITE_WEBSITE;

  it.concurrent(
    "reports the team's limit from a cold and a warm ACUC alike",
    async () => {
      const identity = await idmux({
        name: "concurrency/reports the team's limit from a cold and a warm ACUC alike",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const maxConcurrency = async () => {
        const res = await request(TEST_API_URL)
          .get("/v2/team/queue-status")
          .set("Authorization", `Bearer ${identity.apiKey}`);
        expect(res.statusCode).toBe(200);
        return res.body.maxConcurrency;
      };

      expect(await maxConcurrency()).toBe(accountConcurrencyLimit);
      expect(await maxConcurrency()).toBe(accountConcurrencyLimit);
    },
    60000,
  );

  it.concurrent(
    "crawl utilizes full concurrency limit and doesn't go over",
    async () => {
      const identity = await idmux({
        name: "concurrency/crawl utilizes full concurrency limit and doesn't go over",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const limit = accountConcurrencyLimit * 2;

      const { crawl, concurrencies } = await crawlWithConcurrencyTracking(
        {
          url: base,
          limit,
        },
        identity,
      );

      expect(Math.max(...concurrencies)).toBe(accountConcurrencyLimit);
      expect(crawl.completed).toBe(limit);
    },
    600000,
  );

  it.concurrent(
    "crawl handles maxConcurrency properly",
    async () => {
      const identity = await idmux({
        name: "concurrency/crawl handles maxConcurrency properly",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const { crawl, concurrencies } = await crawlWithConcurrencyTracking(
        {
          url: base,
          limit: 15,
          maxConcurrency: 5,
        },
        identity,
      );

      expect(Math.max(...concurrencies)).toBe(5);
      expect(crawl.completed).toBe(15);
    },
    600000,
  );

  it.concurrent(
    "crawl maxConcurrency stacks properly",
    async () => {
      const identity = await idmux({
        name: "concurrency/crawl maxConcurrency stacks properly",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const [
        { crawl: crawl1, concurrencies: concurrencies1 },
        { crawl: crawl2, concurrencies: concurrencies2 },
      ] = await Promise.all([
        crawlWithConcurrencyTracking(
          {
            url: base,
            limit: 15,
            maxConcurrency: 5,
          },
          identity,
        ),
        crawlWithConcurrencyTracking(
          {
            url: base,
            limit: 15,
            maxConcurrency: 5,
          },
          identity,
        ),
      ]);

      expect(Math.max(...concurrencies1, ...concurrencies2)).toBe(10);
      expect(crawl1.completed).toBe(15);
      expect(crawl2.completed).toBe(15);
    },
    1200000,
  );

  it.concurrent(
    "batch scrape utilizes full concurrency limit and doesn't go over",
    async () => {
      const identity = await idmux({
        name: "concurrency/batch scrape utilizes full concurrency limit and doesn't go over",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const limit = accountConcurrencyLimit * 2;

      const { batchScrape, concurrencies } =
        await batchScrapeWithConcurrencyTracking(
          {
            urls: Array(limit)
              .fill(0)
              .map(_ => base),
          },
          identity,
        );

      expect(Math.max(...concurrencies)).toBe(accountConcurrencyLimit);
      expect(batchScrape.completed).toBe(limit);
    },
    600000,
  );

  it.concurrent(
    "batch scrape handles maxConcurrency properly",
    async () => {
      const identity = await idmux({
        name: "concurrency/batch scrape handles maxConcurrency properly",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const { batchScrape, concurrencies } =
        await batchScrapeWithConcurrencyTracking(
          {
            urls: Array(15)
              .fill(0)
              .map(_ => base),
            maxConcurrency: 5,
          },
          identity,
        );

      expect(Math.max(...concurrencies)).toBe(5);
      expect(batchScrape.completed).toBe(15);
    },
    600000,
  );

  it.concurrent(
    "batch scrape maxConcurrency stacks properly",
    async () => {
      const identity = await idmux({
        name: "concurrency/batch scrape maxConcurrency stacks properly",
        concurrency: accountConcurrencyLimit,
        credits: 100,
      });

      const [
        { batchScrape: batchScrape1, concurrencies: concurrencies1 },
        { batchScrape: batchScrape2, concurrencies: concurrencies2 },
      ] = await Promise.all([
        batchScrapeWithConcurrencyTracking(
          {
            urls: Array(15)
              .fill(0)
              .map(_ => base),
            maxConcurrency: 5,
          },
          identity,
        ),
        batchScrapeWithConcurrencyTracking(
          {
            urls: Array(15)
              .fill(0)
              .map(_ => base),
            maxConcurrency: 5,
          },
          identity,
        ),
      ]);

      expect(Math.max(...concurrencies1, ...concurrencies2)).toBe(10);
      expect(batchScrape1.completed).toBe(15);
      expect(batchScrape2.completed).toBe(15);
    },
    1200000,
  );
});
