import { getJobFromGCS } from "../../../lib/gcs-jobs";
import {
  scrape,
  crawl,
  batchScrape,
  scrapeStatusRaw,
  zdrcleaner,
  idmux,
  searchRaw,
} from "./lib";
import { describeIf, TEST_PRODUCTION, scrapeTimeout } from "../lib";
import {
  getLogs,
  expectScrapeIsCleanedUp,
  expectCrawlIsCleanedUp,
  expectScrapesOfRequestAreCleanedUp,
  expectScrapesAreFullyCleanedAfterZDRCleaner,
  expectBatchScrapeIsCleanedUp,
} from "../zdr-helpers";

describeIf(TEST_PRODUCTION)("Zero Data Retention", () => {
  describe.each(["Team-scoped", "Request-scoped"] as const)("%s", scope => {
    it("should clean up a scrape immediately", async () => {
      let identity = await idmux({
        name: `zdr/${scope}/scrape`,
        credits: 10000,
        flags: {
          scrapeZDR: scope === "Team-scoped" ? "forced" : "allowed",
        },
      });

      const testId = crypto.randomUUID();
      const scrape1 = await scrape(
        {
          url: "https://firecrawl.dev/?test=" + testId,
          zeroDataRetention: scope === "Request-scoped" ? true : undefined,
        },
        identity,
      );

      const gcsJob = await getJobFromGCS(scrape1.metadata.scrapeId!);
      expect(gcsJob).toBeNull();

      await expectScrapeIsCleanedUp(scrape1.metadata.scrapeId!);

      if (scope === "Request-scoped") {
        const status = await scrapeStatusRaw(
          scrape1.metadata.scrapeId!,
          identity,
        );

        expect(status.statusCode).toBe(404);
      }
    }, 60000);

    it(
      "should clean up a crawl",
      async () => {
        const preLogs = await getLogs();

        let identity = await idmux({
          name: `zdr/${scope}/crawl`,
          credits: 10000,
          flags: {
            scrapeZDR: scope === "Team-scoped" ? "forced" : "allowed",
          },
        });

        const crawl1 = await crawl(
          {
            url: "https://firecrawl.dev",
            limit: 10,
            zeroDataRetention: scope === "Request-scoped" ? true : undefined,
          },
          identity,
        );

        const postLogs = (await getLogs()).slice(preLogs.length);

        if (postLogs.length > 0) {
          console.warn("Logs changed during crawl", postLogs);
        }

        expect(postLogs).toHaveLength(0);

        // wait 20 seconds for crawl finish cron to fire
        await new Promise(resolve => setTimeout(resolve, 20000));

        await expectCrawlIsCleanedUp(crawl1.id);

        const scrapes = await expectScrapesOfRequestAreCleanedUp(crawl1.id);

        await zdrcleaner(identity.teamId!);

        await expectScrapesAreFullyCleanedAfterZDRCleaner(
          scrapes,
          scope,
          identity,
          scrapeStatusRaw,
        );
      },
      600000 + 20000,
    );

    it(
      "should clean up a batch scrape",
      async () => {
        const preLogs = await getLogs();

        let identity = await idmux({
          name: `zdr/${scope}/batch-scrape`,
          credits: 10000,
          flags: {
            scrapeZDR: scope === "Team-scoped" ? "forced" : "allowed",
          },
        });

        const crawl1 = await batchScrape(
          {
            urls: ["https://firecrawl.dev", "https://mendable.ai"],
            zeroDataRetention: scope === "Request-scoped" ? true : undefined,
          },
          identity,
        );
        const postLogs = (await getLogs()).slice(preLogs.length);

        if (postLogs.length > 0) {
          console.warn("Logs changed during batch scrape", postLogs);
        }

        expect(postLogs).toHaveLength(0);

        // wait 20 seconds for batch scrape finish cron to fire
        await new Promise(resolve => setTimeout(resolve, 20000));

        await expectBatchScrapeIsCleanedUp(crawl1.id);

        const scrapes = await expectScrapesOfRequestAreCleanedUp(crawl1.id, 2);

        await zdrcleaner(identity.teamId!);

        await expectScrapesAreFullyCleanedAfterZDRCleaner(
          scrapes,
          scope,
          identity,
          scrapeStatusRaw,
        );
      },
      600000 + 20000,
    );
  });

  it(
    "should allow screenshots and clean them up",
    async () => {
      const identity = await idmux({
        name: "zdr/screenshot",
        credits: 10000,
        flags: { scrapeZDR: "allowed" },
      });

      const scrape1 = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["screenshot"],
          zeroDataRetention: true,
        },
        identity,
      );

      expect(scrape1.screenshot).toBeDefined();

      const gcsJob = await getJobFromGCS(scrape1.metadata.scrapeId!);
      expect(gcsJob).toBeNull();

      await expectScrapeIsCleanedUp(scrape1.metadata.scrapeId!);
    },
    scrapeTimeout,
  );

  it(
    "should allow pdf actions and clean them up",
    async () => {
      const identity = await idmux({
        name: "zdr/pdf-action",
        credits: 10000,
        flags: { scrapeZDR: "allowed" },
      });

      const scrape1 = await scrape(
        {
          url: "https://firecrawl.dev",
          actions: [{ type: "pdf" }],
          zeroDataRetention: true,
        },
        identity,
      );

      expect(scrape1.actions?.pdfs).toBeDefined();
      expect(scrape1.actions?.pdfs?.length).toBe(1);

      const gcsJob = await getJobFromGCS(scrape1.metadata.scrapeId!);
      expect(gcsJob).toBeNull();

      await expectScrapeIsCleanedUp(scrape1.metadata.scrapeId!);
    },
    scrapeTimeout,
  );

  it("should allow search when searchZDR is forced", async () => {
    const identity = await idmux({
      name: "zdr/search-forced",
      credits: 10000,
      flags: { searchZDR: "forced" },
    });

    const response = await searchRaw(
      { query: "firecrawl", limit: 1 },
      identity,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
  }, 60000);
});
