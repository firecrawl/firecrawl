import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  asyncBatchScrape,
  asyncBatchScrapeWaitForFinish,
  batchScrape,
  batchScrapeOngoing,
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

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "ongoing batch scrapes endpoint works",
    async () => {
      const beforeStart = new Date();

      const res = await asyncBatchScrape(
        {
          urls: [TEST_SUITE_WEBSITE],
        },
        identity,
      );

      const ongoing = await batchScrapeOngoing(identity);
      const afterStart = new Date();

      const item = ongoing.batchScrapes.find(x => x.id === res.id);
      expect(item).toBeDefined();

      if (item) {
        expect(item.created_at).toBeDefined();
        expect(typeof item.created_at).toBe("string");
        expect(item.created_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
        const createdAtDate = new Date(item.created_at);
        expect(createdAtDate.getTime()).toBeGreaterThanOrEqual(
          beforeStart.getTime() - 1000,
        );
        expect(createdAtDate.getTime()).toBeLessThanOrEqual(
          afterStart.getTime() + 1000,
        );
        expect(typeof item.urlCount).toBe("number");
        expect(item.urlCount).toBeGreaterThanOrEqual(1);
        expect(item.teamId).toBe(identity.teamId);
      }

      // /active alias
      const active = await batchScrapeOngoing(identity, "active");
      expect(active.batchScrapes.find(x => x.id === res.id)).toBeDefined();

      await asyncBatchScrapeWaitForFinish(res.id, identity);

      // wait for finish to propagate
      await new Promise(resolve => setTimeout(resolve, 15000));

      const after = await batchScrapeOngoing(identity);
      expect(after.batchScrapes.find(x => x.id === res.id)).toBeUndefined();
    },
    3 * scrapeTimeout + 15000,
  );
});
