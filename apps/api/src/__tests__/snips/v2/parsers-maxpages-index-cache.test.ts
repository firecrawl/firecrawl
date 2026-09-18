import { describeIf, TEST_PRODUCTION, TEST_SUITE_WEBSITE } from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, indexCooldown } from "./lib";
import type { ScrapeRequestInput } from "../../../controllers/v2/types";
import crypto from "crypto";

describeIf(TEST_PRODUCTION)(
  "V2 Scrape parsers[pdf].maxPages index caching",
  () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "v2-parsers-maxpages-index-cache",
        concurrency: 100,
        credits: 1000000,
      });
    }, 10000);

    test(
      "caches a PDF whose page count fits under maxPages",
      async () => {
        const url = `${TEST_SUITE_WEBSITE}/example.pdf`;
        const body = {
          url,
          parsers: [{ type: "pdf", maxPages: 10000 }],
          maxAge: scrapeTimeout * 2,
          timeout: scrapeTimeout,
        } satisfies ScrapeRequestInput;

        const response1 = await scrape(body, identity);
        expect(response1.metadata.cacheState).toBe("miss");

        await new Promise(resolve => setTimeout(resolve, indexCooldown));

        const response2 = await scrape(body, identity);
        expect(response2.metadata.cacheState).toBe("hit");
      },
      scrapeTimeout * 2 + indexCooldown + 10000,
    );

    test(
      "does not cache a PDF truncated by maxPages",
      async () => {
        const url = `${TEST_SUITE_WEBSITE}/example-long.pdf`;
        const body = {
          url,
          parsers: [{ type: "pdf", maxPages: 3 }],
          maxAge: scrapeTimeout * 2,
          timeout: scrapeTimeout,
        } satisfies ScrapeRequestInput;

        const response1 = await scrape(body, identity);
        expect(response1.metadata.cacheState).toBe("miss");
        expect(response1.metadata.totalPages).toBeGreaterThan(3);
        expect(response1.metadata.numPages).toBe(3);

        await new Promise(resolve => setTimeout(resolve, indexCooldown));

        const response2 = await scrape(body, identity);
        expect(response2.metadata.cacheState).toBe("miss");
      },
      scrapeTimeout * 2 + indexCooldown + 10000,
    );

    test(
      "caches HTML scrapes with a maxPages parser set",
      async () => {
        const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
        const body = {
          url,
          parsers: [{ type: "pdf", maxPages: 100 }],
          maxAge: scrapeTimeout * 2,
          timeout: scrapeTimeout,
        } satisfies ScrapeRequestInput;

        const response1 = await scrape(body, identity);
        expect(response1.metadata.cacheState).toBe("miss");

        await new Promise(resolve => setTimeout(resolve, indexCooldown));

        const response2 = await scrape(body, identity);
        expect(response2.metadata.cacheState).toBe("hit");
      },
      scrapeTimeout * 2 + indexCooldown + 10000,
    );
  },
);
