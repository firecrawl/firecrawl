import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  batchScrape,
  batchScrapeStart,
  batchScrapeStatusWithParams,
  expectBatchScrapeStartToSucceed,
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
    "skip_data query parameter omits data field",
    async () => {
      // Start a batch scrape
      const bss = await batchScrapeStart(
        { urls: [TEST_SUITE_WEBSITE] },
        identity,
      );
      expectBatchScrapeStartToSucceed(bss);

      // Check status with skip_data=true
      const response = await batchScrapeStatusWithParams(
        bss.body.id,
        identity,
        { skip_data: "true" },
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body).not.toHaveProperty("data");
      expect(response.body).toHaveProperty("status");
      expect(response.body).toHaveProperty("completed");
      expect(response.body).toHaveProperty("total");
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
            formats: ["json"],
            jsonOptions: {
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
                required: ["company_mission", "supports_sso", "is_open_source"],
              },
            },
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
