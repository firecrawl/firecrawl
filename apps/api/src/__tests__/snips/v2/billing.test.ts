import { describeIf, TEST_PRODUCTION, TEST_SUITE_WEBSITE } from "../lib";
import {
  batchScrape,
  crawl,
  creditUsage,
  creditUsageHistorical,
  tokenUsageHistorical,
  idmux,
  map,
  scrape,
  search,
} from "./lib";

const sleep = (ms: number) => new Promise(x => setTimeout(() => x(true), ms));
const sleepForBatchBilling = () => sleep(40000);

// TODO: can be combined with v1...?
// TODO: fix up idmux
// TODO: needs testing
describeIf(TEST_PRODUCTION)("Billing tests", () => {
  it.concurrent(
    "bills scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills scrape correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run all scrape operations in parallel with Promise.all
      const [scrape1, scrape2, scrape3, scrape4] = await Promise.all([
        // scrape 1: regular fc.dev scrape (1 credit)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
          },
          identity,
        ),

        // scrape 1.1: regular fc.dev scrape (1 credit)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
          },
          identity,
        ),

        // scrape 2: fc.dev with json (5 credits)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    is_open_source: { type: "boolean" },
                  },
                  required: ["is_open_source"],
                },
              },
            ],
          },
          identity,
        ),

        // scrape 3: fc.dev with query (5 credits)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            formats: [{ type: "query", prompt: "What is Firecrawl?" }],
          },
          identity,
        ),
      ]);

      expect(scrape1.metadata.creditsUsed).toBe(1);
      expect(scrape2.metadata.creditsUsed).toBe(1);
      expect(scrape3.metadata.creditsUsed).toBe(5);
      expect(scrape4.metadata.creditsUsed).toBe(5);

      // sum: 12 credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      expect(rc1 - rc2).toBe(12);
    },
    120000,
  );

  it.concurrent(
    "bills batch scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills batch scrape correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run both scrape operations in parallel with Promise.all
      const [scrape1, scrape2] = await Promise.all([
        // scrape 1: regular batch scrape with failing domain (2 credits)
        batchScrape(
          {
            urls: [
              TEST_SUITE_WEBSITE,
              "https://mendable.ai",
              "https://thisdomaindoesnotexistandwillfail.fcr",
            ],
          },
          identity,
        ),

        // scrape 2: batch scrape with json (10 credits)
        batchScrape(
          {
            urls: [
              TEST_SUITE_WEBSITE,
              "https://mendable.ai",
              "https://thisdomaindoesnotexistandwillfail.fcr",
            ],
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    four_word_summary: { type: "string" },
                  },
                  required: ["four_word_summary"],
                },
              },
            ],
          },
          identity,
        ),
      ]);

      expect(scrape1.data[0].metadata.creditsUsed).toBe(1);
      expect(scrape1.data[1].metadata.creditsUsed).toBe(1);

      expect(scrape2.data[0].metadata.creditsUsed).toBe(5);
      expect(scrape2.data[1].metadata.creditsUsed).toBe(5);

      // sum: 12 credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      expect(rc1 - rc2).toBe(12);
    },
    600000,
  );

  it.concurrent(
    "bills crawl correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills crawl correctly",
        credits: 200,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run both crawl operations in parallel with Promise.all
      const [crawl1, crawl2] = await Promise.all([
        // crawl 1: regular fc.dev crawl (x credits)
        crawl(
          {
            url: TEST_SUITE_WEBSITE,
            limit: 10,
          },
          identity,
        ),

        // crawl 2: fc.dev crawl with json (5y credits)
        crawl(
          {
            url: TEST_SUITE_WEBSITE,
            scrapeOptions: {
              formats: [
                {
                  type: "json",
                  schema: {
                    type: "object",
                    properties: {
                      four_word_summary: { type: "string" },
                    },
                    required: ["four_word_summary"],
                  },
                },
              ],
            },
            limit: 10,
          },
          identity,
        ),
      ]);

      expect(crawl1.success).toBe(true);
      expect(crawl2.success).toBe(true);

      // sum: x+5y credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      if (crawl1.success && crawl2.success) {
        expect(rc1 - rc2).toBe(crawl1.completed + crawl2.completed * 5);
      }
    },
    600000,
  );

  it.concurrent(
    "bills map correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills map correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;
      await map({ url: TEST_SUITE_WEBSITE }, identity);
      await sleepForBatchBilling();
      const rc2 = (await creditUsage(identity)).remainingCredits;
      expect(rc1 - rc2).toBe(1);
    },
    60000,
  );

  it.concurrent(
    "bills search correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills search correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      const results = await search(
        {
          query: "firecrawl",
        },
        identity,
      );

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      const creditDiff = rc1 - rc2;

      const resultCount = results.web?.length ?? 0;
      const resultCost = Math.ceil(resultCount / 10) * 2; // 2 credits per 10 results

      expect(creditDiff).toBe(resultCost);
    },
    60000,
  );

  it.concurrent(
    "bills search with scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills search with scrape correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      const results = await search(
        {
          query: "coconut",
          scrapeOptions: {
            formats: ["markdown"],
          },
        },
        identity,
      );

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      expect(rc1 - rc2).toBe(results.web?.length ?? 0);
    },
    600000,
  );

  it.concurrent(
    "bills search with PDF scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills search with PDF scrape correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      const results = await search(
        {
          query: "coconut filetype:pdf",
          scrapeOptions: {
            formats: ["markdown"],
            parsers: ["pdf"],
          },
        },
        identity,
      );

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      const shouldUse =
        results.web?.reduce(
          (sum, doc) => sum + (doc.metadata?.numPages || 1),
          0,
        ) ?? 0;

      expect(rc1 - rc2).toBe(shouldUse);
    },
    600000,
  );

  it.concurrent(
    "bills search with parsePDF=false correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills search with parsePDF=false correctly",
        credits: 100,
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      const results = await search(
        {
          query: "coconut filetype:pdf",
          scrapeOptions: {
            formats: ["markdown"],
            parsers: [],
          },
        },
        identity,
      );

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      const expectedCredits = results.web?.length ?? 0;

      expect(rc1 - rc2).toBe(expectedCredits);
    },
    600000,
  );

  it.concurrent(
    "bills ZDR scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills ZDR scrape correctly",
        credits: 100,
        flags: {
          scrapeZDR: "allowed",
        },
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run all scrape operations in parallel with Promise.all
      const [scrape1, scrape2, scrape3] = await Promise.all([
        // scrape 1: regular fc.dev scrape (1 credit)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            zeroDataRetention: true,
          },
          identity,
        ),

        // scrape 1.1: regular fc.dev scrape (1 credit)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            zeroDataRetention: true,
          },
          identity,
        ),

        // scrape 2: fc.dev with json (5 credits)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    is_open_source: { type: "boolean" },
                  },
                  required: ["is_open_source"],
                },
              },
            ],
            zeroDataRetention: true,
          },
          identity,
        ),
      ]);

      expect(scrape1.metadata.creditsUsed).toBe(2);
      expect(scrape2.metadata.creditsUsed).toBe(2);
      expect(scrape3.metadata.creditsUsed).toBe(6);

      // sum: 10 credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      expect(rc1 - rc2).toBe(10);
    },
    120000,
  );

  it.concurrent(
    "bills ZDR batch scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills ZDR batch scrape correctly",
        credits: 100,
        flags: {
          scrapeZDR: "allowed",
        },
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run both scrape operations in parallel with Promise.all
      const [scrape1, scrape2] = await Promise.all([
        // scrape 1: regular batch scrape with failing domain (2 credits)
        batchScrape(
          {
            urls: [
              TEST_SUITE_WEBSITE,
              "https://mendable.ai",
              "https://thisdomaindoesnotexistandwillfail.fcr",
            ],
            zeroDataRetention: true,
          },
          identity,
        ),

        // scrape 2: batch scrape with json (10 credits)
        batchScrape(
          {
            urls: [
              TEST_SUITE_WEBSITE,
              "https://mendable.ai",
              "https://thisdomaindoesnotexistandwillfail.fcr",
            ],
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    four_word_summary: { type: "string" },
                  },
                  required: ["four_word_summary"],
                },
              },
            ],
            zeroDataRetention: true,
          },
          identity,
        ),
      ]);

      expect(scrape1.data[0].metadata.creditsUsed).toBe(2);
      expect(scrape1.data[1].metadata.creditsUsed).toBe(2);

      expect(scrape2.data[0].metadata.creditsUsed).toBe(6);
      expect(scrape2.data[1].metadata.creditsUsed).toBe(6);

      // sum: 16 credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      expect(rc1 - rc2).toBe(16);
    },
    600000,
  );

  it.concurrent(
    "bills ZDR crawl correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills ZDR crawl correctly",
        credits: 200,
        flags: {
          scrapeZDR: "allowed",
        },
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run both crawl operations in parallel with Promise.all
      const [crawl1, crawl2] = await Promise.all([
        // crawl 1: regular fc.dev crawl (x credits)
        crawl(
          {
            url: TEST_SUITE_WEBSITE,
            limit: 10,
            zeroDataRetention: true,
          },
          identity,
        ),

        // crawl 2: fc.dev crawl with json (5y credits)
        crawl(
          {
            url: TEST_SUITE_WEBSITE,
            scrapeOptions: {
              formats: [
                {
                  type: "json",
                  schema: {
                    type: "object",
                    properties: {
                      four_word_summary: { type: "string" },
                    },
                    required: ["four_word_summary"],
                  },
                },
              ],
            },
            limit: 10,
            zeroDataRetention: true,
          },
          identity,
        ),
      ]);

      expect(crawl1.success).toBe(true);
      expect(crawl2.success).toBe(true);

      // sum: 2x+6y credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      if (crawl1.success && crawl2.success) {
        expect(rc1 - rc2).toBe(crawl1.completed * 2 + crawl2.completed * 6);
      }
    },
    600000,
  );

  it.concurrent(
    "returns historical credit usage",
    async () => {
      const identity = await idmux({
        name: "billing/returns historical credit usage",
        credits: 100,
      });

      const result = await creditUsageHistorical(identity);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.periods)).toBe(true);

      for (const period of result.periods) {
        expect(typeof period.creditsUsed).toBe("number");
        expect(period.creditsUsed).toBeGreaterThanOrEqual(0);
      }

      // Verify periods are sorted by startDate ascending
      for (let i = 1; i < result.periods.length; i++) {
        const prevRaw = result.periods[i - 1].startDate ? Date.parse(result.periods[i - 1].startDate!) : NaN;
        const currRaw = result.periods[i].startDate ? Date.parse(result.periods[i].startDate!) : NaN;
        const prevNaN = Number.isNaN(prevRaw);
        const currNaN = Number.isNaN(currRaw);
        if (!prevNaN && !currNaN) {
          expect(currRaw).toBeGreaterThanOrEqual(prevRaw);
        } else if (!prevNaN && currNaN) {
          // null dates sorted last — valid
        }
      }
    },
    60000,
  );

  it.concurrent(
    "returns historical token usage",
    async () => {
      const identity = await idmux({
        name: "billing/returns historical token usage",
        credits: 100,
      });

      const result = await tokenUsageHistorical(identity);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.periods)).toBe(true);

      for (const period of result.periods) {
        expect(typeof period.tokensUsed).toBe("number");
        expect(period.tokensUsed).toBeGreaterThanOrEqual(0);
      }

      // Verify periods are sorted by startDate ascending
      for (let i = 1; i < result.periods.length; i++) {
        const prev = new Date(result.periods[i - 1].startDate ?? 0).getTime();
        const curr = new Date(result.periods[i].startDate ?? 0).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    },
    60000,
  );

  it.concurrent(
    "bills custom-cost ZDR scrape correctly",
    async () => {
      const identity = await idmux({
        name: "billing/bills ZDR scrape correctly",
        credits: 100,
        flags: {
          scrapeZDR: "allowed",
          zdrCost: 0,
        },
      });

      const rc1 = (await creditUsage(identity)).remainingCredits;

      // Run all scrape operations in parallel with Promise.all
      const [scrape1, scrape2, scrape3] = await Promise.all([
        // scrape 1: regular fc.dev scrape (1 credit)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            zeroDataRetention: true,
          },
          identity,
        ),

        // scrape 1.1: regular fc.dev scrape (1 credit)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            zeroDataRetention: true,
          },
          identity,
        ),

        // scrape 2: fc.dev with json (5 credits)
        scrape(
          {
            url: TEST_SUITE_WEBSITE,
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    is_open_source: { type: "boolean" },
                  },
                  required: ["is_open_source"],
                },
              },
            ],
            zeroDataRetention: true,
          },
          identity,
        ),
      ]);

      expect(scrape1.metadata.creditsUsed).toBe(1);
      expect(scrape2.metadata.creditsUsed).toBe(1);
      expect(scrape3.metadata.creditsUsed).toBe(5);

      // sum: 7 credits

      await sleepForBatchBilling();

      const rc2 = (await creditUsage(identity)).remainingCredits;

      expect(rc1 - rc2).toBe(7);
    },
    120000,
  );
});
