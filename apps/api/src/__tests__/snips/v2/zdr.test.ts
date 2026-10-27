import { getJobFromGCS } from "../../../lib/gcs-jobs";
import {
  scrape,
  crawl,
  batchScrape,
  scrapeStatusRaw,
  zdrcleaner,
  idmux,
  searchRaw,
  Identity,
} from "./lib";
import {
  describeIf,
  itIf,
  concurrentIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  HAS_PRODUCT_SERVICE,
  scrapeTimeout,
} from "../lib";
import {
  getLogs,
  expectScrapeIsCleanedUp,
  expectCrawlIsCleanedUp,
  expectScrapesOfRequestAreCleanedUp,
  expectScrapesAreFullyCleanedAfterZDRCleaner,
  expectBatchScrapeIsCleanedUp,
} from "../zdr-helpers";
import { HAS_JOB_LOG } from "../job-log";

describeIf(TEST_PRODUCTION)("Zero Data Retention", () => {
  const scopes = ["Team-scoped", "Request-scoped"] as const;
  describeIf(HAS_JOB_LOG).each(scopes)("%s", scope => {
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

  itIf(HAS_JOB_LOG)(
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

  itIf(HAS_JOB_LOG)(
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

  describe.each(scopes)("%s audio, video and product formats", scope => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: `zdr/${scope}/formats`,
        credits: 10000,
        flags: {
          scrapeZDR: scope === "Team-scoped" ? "forced" : "allowed",
        },
      });
    }, scrapeTimeout);

    const zeroDataRetention = scope === "Request-scoped" ? true : undefined;

    it.concurrent(
      "refuses the audio format without attempting the download",
      async () => {
        // Not a supported media URL: a download attempt would fail the scrape.
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["markdown", "audio"],
            zeroDataRetention,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.audio).toBeUndefined();
        expect(response.warning).toContain(
          "Audio format is not supported with zero data retention.",
        );
      },
      scrapeTimeout,
    );

    it.concurrent(
      "refuses the video format without attempting the download",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["markdown", "video"],
            zeroDataRetention,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.video).toBeUndefined();
        expect(response.videos).toBeUndefined();
        expect(response.warning).toContain(
          "Video format is not supported with zero data retention.",
        );
      },
      scrapeTimeout,
    );

    it.concurrent(
      "refuses the product format",
      async () => {
        const response = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/product`,
            formats: ["markdown", { type: "product" }],
            zeroDataRetention,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.product).toBeUndefined();
        expect(response.warning).toContain(
          "Product format is not supported with zero data retention.",
        );
      },
      scrapeTimeout,
    );
  });

  describe("audio, video and product formats without zero data retention on the request", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "zdr/allowed/formats-without-zdr",
        credits: 10000,
        flags: { scrapeZDR: "allowed" },
      });
    }, scrapeTimeout);

    it.concurrent(
      "still returns audio",
      async () => {
        const response = await scrape(
          {
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            formats: ["audio"],
          },
          identity,
        );

        expect(response.audio).toMatch(/^https:\/\//);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "still returns video",
      async () => {
        const response = await scrape(
          {
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            formats: ["video"],
          },
          identity,
        );

        expect(response.video).toMatch(/^https:\/\//);
      },
      scrapeTimeout * 2,
    );

    concurrentIf(HAS_PRODUCT_SERVICE)(
      "still returns the product",
      async () => {
        const response = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/product`,
            formats: [{ type: "product" }],
          },
          identity,
        );

        expect(response.product?.title).toBe("Firecrawl Test Widget");
      },
      scrapeTimeout,
    );
  });
});
