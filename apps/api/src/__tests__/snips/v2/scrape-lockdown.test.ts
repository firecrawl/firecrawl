import { describeIf, TEST_PRODUCTION } from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";
import { expectScrapeIsCleanedUp } from "../zdr-helpers";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import crypto from "crypto";

describeIf(TEST_PRODUCTION)("V2 Scrape Lockdown Mode", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-lockdown",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  test(
    "should hit cache with lockdown: true after a prior non-lockdown scrape seeded the index",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // Seed the cache with a normal scrape
      const seed = await scrape(
        {
          url,
        },
        identity,
      );

      expect(seed).toBeDefined();
      expect(seed.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise(resolve => setTimeout(resolve, 20000));

      // Lockdown scrape should hit the seeded cache
      const data = await scrape(
        {
          url,
          lockdown: true,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.metadata.cacheState).toBe("hit");
      expect(data.metadata.cachedAt).toBeDefined();
      expect(data.metadata.creditsUsed).toBe(5);
    },
    scrapeTimeout * 2 + 20000,
  );

  test(
    "should return SCRAPE_LOCKDOWN_CACHE_MISS when nothing is cached",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?lockdownMiss=" + id;

      const response = await scrapeRaw(
        {
          url,
          lockdown: true,
        },
        identity,
      );

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("SCRAPE_LOCKDOWN_CACHE_MISS");
    },
    scrapeTimeout,
  );

  test(
    "should treat lockdown as ZDR — no URL in DB, no GCS blob",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?lockdownZdr=" + id;

      const seed = await scrape({ url }, identity);
      expect(seed).toBeDefined();
      expect(seed.metadata.cacheState).toBe("miss");

      await new Promise(resolve => setTimeout(resolve, 20000));

      const data = await scrape({ url, lockdown: true }, identity);
      expect(data).toBeDefined();
      expect(data.metadata.cacheState).toBe("hit");

      const scrapeId = data.metadata.scrapeId!;
      await expectScrapeIsCleanedUp(scrapeId);

      const gcsJob = await getJobFromGCS(scrapeId);
      expect(gcsJob).toBeNull();
    },
    scrapeTimeout * 2 + 20000,
  );

  test(
    "should serve cache and skip audio fetch even when audio format is requested",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testAudioGate=" + id;

      const seed = await scrape({ url }, identity);
      expect(seed).toBeDefined();
      expect(seed.metadata.cacheState).toBe("miss");

      await new Promise(resolve => setTimeout(resolve, 20000));

      // Without the lockdown audio gate this would either throw
      // AudioUnsupportedUrlError (firecrawl.dev is not an audio source) or
      // POST to AVGRAB_SERVICE_URL with the target URL. Success here implies
      // the gate short-circuited before any outbound call.
      const data = await scrape(
        {
          url,
          lockdown: true,
          formats: ["markdown", "audio"],
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.metadata.cacheState).toBe("hit");
      expect(data.audio).toBeUndefined();
    },
    scrapeTimeout * 2 + 20000,
  );
});
