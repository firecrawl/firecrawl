import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  batchScrape,
  batchScrapeStartRaw,
  batchScrapeStatusRaw,
  batchScrapeCancelRaw,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "batch-scrape",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Batch scrape tests", () => {
  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "works",
    async () => {
      const response = await batchScrape(
        {
          urls: [TEST_SUITE_WEBSITE],
        },
        identity,
      );

      expect(response.data[0]).toHaveProperty("markdown");
      expect(response.data[0].markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "sourceURL stays unnormalized",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}/?pagewanted=all&et_blog`;
      const response = await batchScrape(
        {
          urls: [url],
        },
        identity,
      );

      expect(response.data[0].metadata.sourceURL).toBe(url);
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "cancel flips status to cancelled and stops 404'ing on GET",
    async () => {
      // Queue enough URLs that the batch won't complete before we cancel.
      const urls = Array.from(
        { length: 50 },
        (_, i) => `${TEST_SUITE_WEBSITE}/?cancel-test=${i}`,
      );

      const start = await batchScrapeStartRaw({ urls }, identity);
      expect(start.statusCode).toBe(200);
      expect(start.body.success).toBe(true);
      const jobId: string = start.body.id;

      const cancel = await batchScrapeCancelRaw(jobId, identity);
      expect(cancel.statusCode).toBe(200);
      expect(cancel.body).toEqual({ status: "cancelled" });

      // GET must immediately report "cancelled" — not "scraping". This is
      // the regression: previously the cancel flag was write-only and the
      // status endpoint kept reading group.status === "active".
      const status = await batchScrapeStatusRaw(jobId, identity);
      expect(status.statusCode).toBe(200);
      expect(status.body.status).toBe("cancelled");
    },
    scrapeTimeout,
  );

  describeIf(TEST_PRODUCTION)("JSON format", () => {
    it.concurrent(
      "works",
      async () => {
        const response = await batchScrape(
          {
            urls: [TEST_SUITE_WEBSITE],
            formats: [
              {
                type: "json",
                prompt:
                  "Based on the information on the page, find what the company's mission is and whether it supports SSO, and whether it is open source.",
                schema: {
                  type: "object",
                  properties: {
                    company_mission: {
                      type: "string",
                    },
                    supports_sso: {
                      type: "boolean",
                    },
                    is_open_source: {
                      type: "boolean",
                    },
                  },
                  required: [
                    "company_mission",
                    "supports_sso",
                    "is_open_source",
                  ],
                },
              },
            ],
          },
          identity,
        );

        expect(response.data[0]).toHaveProperty("json");
        expect(response.data[0].json).toHaveProperty("company_mission");
        expect(typeof response.data[0].json.company_mission).toBe("string");
        expect(response.data[0].json).toHaveProperty("supports_sso");
        expect(response.data[0].json.supports_sso).toBe(false);
        expect(typeof response.data[0].json.supports_sso).toBe("boolean");
        expect(response.data[0].json).toHaveProperty("is_open_source");
        expect(response.data[0].json.is_open_source).toBe(true);
        expect(typeof response.data[0].json.is_open_source).toBe("boolean");
      },
      180000,
    );
  });
});
