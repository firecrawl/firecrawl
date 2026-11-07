import { describeIf, TEST_PRODUCTION, indexCooldown } from "../lib";
import { Identity, idmux, scrapeTimeout, scrape } from "./lib";
import crypto from "crypto";

// E2E coverage for the index URL->id lookup variant semantics, which the
// Dragonfly index cache (services/index-cache.ts) replicates client-side from
// index_get_recent_5. Behavior must be identical whether INDEX_CACHE_REDIS_URL
// is set or not.
describeIf(TEST_PRODUCTION)("V2 index lookup variant matching", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-index-cache-variants",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  test(
    "screenshot-capable index entry serves a request without screenshot",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      const data1 = await scrape(
        {
          url,
          formats: ["markdown", "screenshot"],
        },
        identity,
      );
      expect(data1.metadata.cacheState).toBe("miss");

      await new Promise(resolve => setTimeout(resolve, indexCooldown));

      // A request that doesn't need a screenshot matches entries with or
      // without one (p_feature_screenshot IS NOT TRUE OR has_screenshot).
      const data2 = await scrape(
        {
          url,
          maxAge: 10 * 60 * 1000,
        },
        identity,
      );
      expect(data2.metadata.cacheState).toBe("hit");
    },
    scrapeTimeout * 2 + indexCooldown,
  );

  test(
    "screenshot request does not get served by a screenshotless index entry",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      const data1 = await scrape(
        {
          url,
        },
        identity,
      );
      expect(data1.metadata.cacheState).toBe("miss");

      await new Promise(resolve => setTimeout(resolve, indexCooldown));

      const data2 = await scrape(
        {
          url,
          formats: ["markdown", "screenshot"],
          maxAge: 10 * 60 * 1000,
        },
        identity,
      );
      expect(data2.metadata.cacheState).toBe("miss");
    },
    scrapeTimeout * 2 + indexCooldown,
  );
});
