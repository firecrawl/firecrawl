import { config } from "../../../config";
import {
  createTestIdUrl,
  describeIf,
  concurrentIf,
  itIf,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  HAS_PLAYWRIGHT,
  HAS_PROXY,
  HAS_AI,
  ALLOW_TEST_SUITE_WEBSITE,
} from "../lib";
import {
  scrape,
  scrapeWithFailure,
  scrapeStatus,
  scrapeTimeout,
  indexCooldown,
  idmux,
  Identity,
  scrapeRaw,
  extract,
} from "./lib";
import crypto from "crypto";

const CHANGE_TRACKING_TEST_URL = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape",
    concurrency: 100,
    credits: 1000000,
  });

  if (TEST_PRODUCTION) {
    await scrape(
      {
        url: CHANGE_TRACKING_TEST_URL,
        formats: ["markdown", "changeTracking"],
      },
      identity,
    );
  }
}, 10000 + scrapeTimeout);

describe("Scrape tests", () => {
  const base = TEST_SUITE_WEBSITE;

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "works",
    async () => {
      const response = await scrape(
        {
          url: base,
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  describe("waitFor validation", () => {
    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "rejects waitFor when it exceeds half of timeout",
      async () => {
        const raw = await scrapeRaw(
          {
            url: base,
            waitFor: 8000,
            timeout: 15000,
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("waitFor must not exceed half of timeout");
        expect(raw.body.details).toBeDefined();
        expect(JSON.stringify(raw.body.details)).toContain(
          "waitFor must not exceed half of timeout",
        );
      },
      scrapeTimeout,
    );

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "rejects waitFor when it equals timeout",
      async () => {
        const raw = await scrapeRaw(
          {
            url: base,
            waitFor: 15000,
            timeout: 15000,
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("waitFor must not exceed half of timeout");
        expect(raw.body.details).toBeDefined();
        expect(JSON.stringify(raw.body.details)).toContain(
          "waitFor must not exceed half of timeout",
        );
      },
      scrapeTimeout,
    );

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "rejects waitFor when it exceeds timeout",
      async () => {
        const raw = await scrapeRaw(
          {
            url: base,
            waitFor: 20000,
            timeout: 15000,
          },
          identity,
        );

        expect(raw.statusCode).toBe(400);
        expect(raw.body.success).toBe(false);
        expect(raw.body.error).toBe("waitFor must not exceed half of timeout");
        expect(raw.body.details).toBeDefined();
        expect(JSON.stringify(raw.body.details)).toContain(
          "waitFor must not exceed half of timeout",
        );
      },
      scrapeTimeout,
    );
  });

  // TEMP: domain broken
  // it.concurrent("works with Punycode domains", async () => {
  //   await scrape({
  //     url: "http://xn--1lqv92a901a.xn--ses554g/",
  //     timeout: scrapeTimeout,
  //   }, identity);
  // }, scrapeTimeout);

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "handles non-UTF-8 encodings",
    async () => {
      const response = await scrape(
        {
          url: `${base}/blog/unicode-post`,
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown).toContain(
        "ぐ け げ こ ご さ ざ し じ す ず せ ぜ そ ぞ た",
      );
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)("links format works", async () => {
    const response = await scrape(
      {
        url: base,
        formats: ["links"],
        timeout: scrapeTimeout,
      },
      identity,
    );

    expect(response.links).toBeDefined();
    expect(response.links?.length).toBeGreaterThan(0);
  });

  concurrentIf(TEST_SELF_HOST && HAS_PROXY)(
    "self-hosted proxy works",
    async () => {
      const response = await scrape(
        {
          url: "https://icanhazip.com",
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown?.trim()).toContain(
        config.PROXY_SERVER!.split("://").slice(-1)[0].split(":")[0],
      );
    },
    scrapeTimeout,
  );

  // TODO: check if this is playwright only?
  concurrentIf(TEST_SELF_HOST && HAS_PROXY && HAS_PLAYWRIGHT)(
    "self-hosted proxy works on playwright",
    async () => {
      const response = await scrape(
        {
          url: "https://icanhazip.com",
          waitFor: 100,
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown?.trim()).toContain(
        config.PROXY_SERVER!.split("://").slice(-1)[0].split(":")[0],
      );
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || (HAS_PLAYWRIGHT && ALLOW_TEST_SUITE_WEBSITE))(
    "waitFor works",
    async () => {
      const response = await scrape(
        {
          url: base,
          waitFor: 2000,
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  describe("JSON scrape support", () => {
    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "returns parseable JSON",
      async () => {
        const response = await scrape(
          {
            url: `${base}/example.json`,
            formats: ["rawHtml"],
            timeout: scrapeTimeout,
          },
          identity,
        );

        const obj = JSON.parse(response.rawHtml!);
        expect(obj.id).toBe(1);
      },
      scrapeTimeout,
    );
  });

  describeIf(TEST_PRODUCTION)("Fire-Engine scraping", () => {
    it.concurrent(
      "scrape status works",
      async () => {
        const response = await scrape(
          {
            url: base,
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.markdown).toContain("Firecrawl");

        // Give time to propagate to read replica
        await new Promise(resolve => setTimeout(resolve, 1000));

        const status = await scrapeStatus(
          response.metadata.scrapeId!,
          identity,
        );
        expect(JSON.stringify(status)).toBe(JSON.stringify(response));
      },
      scrapeTimeout,
    );

    describe("Ad blocking (f-e dependant)", () => {
      it.concurrent(
        "blocking ads works",
        async () => {
          await scrape(
            {
              url: base,
              blockAds: true,
              timeout: scrapeTimeout,
            },
            identity,
          );
        },
        scrapeTimeout,
      );

      it.concurrent(
        "doesn't block ads if explicitly disabled",
        async () => {
          await scrape(
            {
              url: base,
              blockAds: false,
              timeout: scrapeTimeout,
            },
            identity,
          );
        },
        scrapeTimeout,
      );
    });

    describe("Index", () => {
      it.concurrent(
        "caches properly",
        async () => {
          const id = crypto.randomUUID();
          const url = `${base}?testId=${id}`;

          const response1 = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 3,
              storeInCache: false,
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 3,
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response3 = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 3,
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response3.metadata.cacheState).toBe("hit");
          expect(response3.metadata.cachedAt).toBeDefined();

          const response4 = await scrape(
            {
              url,
              maxAge: 1,
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response4.metadata.cacheState).toBe("miss");
        },
        scrapeTimeout * 4 + 2 * indexCooldown,
      );

      it.concurrent(
        "caches PDFs properly",
        async () => {
          const url = `${base}/example.pdf`;

          const response1 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 2 + 2 * indexCooldown,
      );

      it.concurrent(
        "respects screenshot",
        async () => {
          const url = createTestIdUrl();

          const response1 = await scrape(
            {
              url,
              formats: ["screenshot"],
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response1.screenshot).toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              formats: ["screenshot"],
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response2.screenshot).toBe(response1.screenshot);

          const response3 = await scrape(
            {
              url,
              formats: ["screenshot@fullPage"],
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3,
            },
            identity,
          );

          expect(response3.screenshot).not.toBe(response1.screenshot);
          expect(response3.metadata.cacheState).toBe("miss");
        },
        scrapeTimeout * 3 + 2 * indexCooldown,
      );

      it.concurrent(
        "respects screenshot@fullPage",
        async () => {
          const url = createTestIdUrl();

          const response1 = await scrape(
            {
              url,
              formats: ["screenshot@fullPage"],
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response1.screenshot).toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              formats: ["screenshot@fullPage"],
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response2.screenshot).toBe(response1.screenshot);

          const response3 = await scrape(
            {
              url,
              formats: ["screenshot"],
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3,
            },
            identity,
          );

          expect(response3.screenshot).not.toBe(response1.screenshot);
          expect(response3.metadata.cacheState).toBe("miss");
        },
        scrapeTimeout * 3 + 1 * indexCooldown,
      );

      it.concurrent(
        "respects changeTracking",
        async () => {
          const url = createTestIdUrl();

          await scrape(
            {
              url,
              formats: ["markdown", "changeTracking"],
              timeout: scrapeTimeout,
            },
            identity,
          );

          const response1 = await scrape(
            {
              url,
              formats: ["markdown", "changeTracking"],
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response1.metadata.cacheState).not.toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              formats: ["markdown"],
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3 + indexCooldown,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 3 + 2 * indexCooldown,
      );

      it.concurrent(
        "respects headers",
        async () => {
          const url = createTestIdUrl();

          await scrape(
            {
              url,
              headers: {
                "X-Test": "test",
              },
              timeout: scrapeTimeout,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2 + indexCooldown,
            },
            identity,
          );

          expect(response.metadata.cacheState).toBe("miss");
        },
        scrapeTimeout * 2 + 1 * indexCooldown,
      );

      it.concurrent(
        "respects mobile",
        async () => {
          const url = createTestIdUrl();

          await scrape(
            {
              url,
              timeout: scrapeTimeout,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response1 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
              mobile: true,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3,
              mobile: true,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 3 + 2 * indexCooldown,
      );

      it.concurrent(
        "respects actions",
        async () => {
          const url = createTestIdUrl();

          const response1 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout,
              actions: [
                {
                  type: "wait",
                  milliseconds: 1000,
                },
              ],
            },
            identity,
          );

          expect(response1.metadata.cacheState).not.toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("miss");
        },
        scrapeTimeout * 2 + 1 * indexCooldown,
      );

      it.concurrent(
        "respects location",
        async () => {
          const url = createTestIdUrl();

          await scrape(
            {
              url,
              timeout: scrapeTimeout,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response1 = await scrape(
            {
              url,
              location: { country: "DE", languages: ["hu-HU", "de-DE"] },
              maxAge: scrapeTimeout * 2,
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              location: { country: "DE", languages: ["de-DE", "hu-HU"] },
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 3 + 2 * indexCooldown,
      );

      it.concurrent(
        "respects blockAds",
        async () => {
          const url = createTestIdUrl();

          await scrape(
            {
              url,
              blockAds: true,
              timeout: scrapeTimeout,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response0 = await scrape(
            {
              url,
              blockAds: true,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2 + indexCooldown,
            },
            identity,
          );

          expect(response0.metadata.cacheState).toBe("hit");

          const response1 = await scrape(
            {
              url,
              blockAds: false,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3 + indexCooldown,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              blockAds: false,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 4 + 2 * indexCooldown,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 4 + 2 * indexCooldown,
      );

      it.concurrent(
        "respects proxy: stealth",
        async () => {
          const url = createTestIdUrl();

          const response1 = await scrape(
            {
              url,
              proxy: "stealth",
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout,
            },
            identity,
          );

          expect(response1.metadata.proxyUsed).toBe("stealth");
          expect(response1.metadata.cacheState).not.toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2 + indexCooldown,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");

          const response3 = await scrape(
            {
              url,
              proxy: "stealth",
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 3 + indexCooldown,
            },
            identity,
          );

          expect(response3.metadata.cacheState).not.toBeDefined();
        },
        scrapeTimeout * 3 + indexCooldown,
      );

      it.concurrent(
        "works properly on pages returning 200",
        async () => {
          const url = createTestIdUrl();

          await scrape(
            {
              url,
              timeout: scrapeTimeout,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response = await scrape(
            {
              url,
              timeout: scrapeTimeout,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 2 + 1 * indexCooldown,
      );

      it.concurrent(
        "does not index PDF scrapes with parsePDF:false",
        async () => {
          const id = crypto.randomUUID();
          const url =
            "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf?testId=" +
            id;

          // First scrape with parsePDF:false and maxAge:0 to force a fresh scrape
          const response1 = await scrape(
            {
              url,
              parsePDF: false,
              maxAge: 0,
              timeout: scrapeTimeout,
            },
            identity,
          );

          // Verify we got base64 content
          expect(response1.metadata.cacheState).not.toBe("hit");
          expect(response1.markdown).toBeDefined();
          // Base64 content should start with JVBERi (which is "%PDF" base64 encoded)
          expect(response1.markdown!.startsWith("JVBERi")).toBe(true);

          // Wait for indexing to potentially happen (it shouldn't)
          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          // Now scrape with parsePDF:true and a high maxAge value
          const response2 = await scrape(
            {
              url,
              parsePDF: true,
              maxAge: scrapeTimeout * 10,
              timeout: scrapeTimeout,
            },
            identity,
          );

          // Should NOT hit cache (because parsePDF:false shouldn't have indexed)
          expect(response2.metadata.cacheState).not.toBe("hit");
          // Should get parsed text content, not base64
          expect(response2.markdown).toBeDefined();
          expect(response2.markdown!.startsWith("JVBERi")).toBe(false);
          // PDF should contain actual text content
          expect(response2.markdown!.toLowerCase()).toContain("dummy");

          // Wait for this one to be indexed
          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          // Now scrape again with parsePDF:true and high maxAge - should hit cache
          const response3 = await scrape(
            {
              url,
              parsePDF: true,
              maxAge: scrapeTimeout * 10,
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response3.metadata.cacheState).toBe("hit");
          expect(response3.metadata.cachedAt).toBeDefined();
          // Should still be parsed text, not base64
          expect(response3.markdown!.startsWith("JVBERi")).toBe(false);
          expect(response3.markdown!.toLowerCase()).toContain("dummy");

          // Verify that scraping with parsePDF:false still doesn't hit cache
          const response4 = await scrape(
            {
              url,
              parsePDF: false,
              maxAge: scrapeTimeout * 10,
              timeout: scrapeTimeout,
            },
            identity,
          );

          // Should not hit cache since parsePDF:false results are not indexed
          expect(response4.metadata.cacheState).not.toBe("hit");
          expect(response4.markdown!.startsWith("JVBERi")).toBe(true);
        },
        scrapeTimeout * 4 + 3 * indexCooldown,
      );
    });

    describe("Change Tracking format", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: CHANGE_TRACKING_TEST_URL,
              formats: ["markdown", "changeTracking"],
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response.changeTracking).toBeDefined();
          expect(response.changeTracking?.previousScrapeAt).not.toBeNull();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "includes git diff when requested",
        async () => {
          const response = await scrape(
            {
              url: CHANGE_TRACKING_TEST_URL,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: {
                modes: ["git-diff"],
              },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response.changeTracking).toBeDefined();
          expect(response.changeTracking?.previousScrapeAt).not.toBeNull();

          if (response.changeTracking?.changeStatus === "changed") {
            expect(response.changeTracking?.diff).toBeDefined();
            expect(response.changeTracking?.diff?.text).toBeDefined();
            expect(response.changeTracking?.diff?.json).toBeDefined();
            expect(response.changeTracking?.diff?.json.files).toBeInstanceOf(
              Array,
            );
          }
        },
        scrapeTimeout,
      );

      it.concurrent(
        "includes structured output when requested",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: {
                modes: ["json"],
                prompt:
                  "Summarize the changes between the previous and current content",
              },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response.changeTracking).toBeDefined();
          expect(response.changeTracking?.previousScrapeAt).not.toBeNull();

          if (response.changeTracking?.changeStatus === "changed") {
            expect(response.changeTracking?.json).toBeDefined();
          }
        },
        scrapeTimeout,
      );

      it.concurrent(
        "supports schema-based extraction for change tracking",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: {
                modes: ["json"],
                schema: {
                  type: "object",
                  properties: {
                    pricing: {
                      type: "object",
                      properties: {
                        amount: { type: "number" },
                        currency: { type: "string" },
                      },
                    },
                    features: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response.changeTracking).toBeDefined();
          expect(response.changeTracking?.previousScrapeAt).not.toBeNull();

          if (response.changeTracking?.changeStatus === "changed") {
            expect(response.changeTracking?.json).toBeDefined();
            if (response.changeTracking?.json.pricing) {
              expect(response.changeTracking?.json.pricing).toHaveProperty(
                "old",
              );
              expect(response.changeTracking?.json.pricing).toHaveProperty(
                "new",
              );
            }
            if (response.changeTracking?.json.features) {
              expect(response.changeTracking?.json.features).toHaveProperty(
                "old",
              );
              expect(response.changeTracking?.json.features).toHaveProperty(
                "new",
              );
            }
          }
        },
        scrapeTimeout,
      );

      it.concurrent(
        "supports both git-diff and structured modes together",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: {
                modes: ["git-diff", "json"],
                schema: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    changes: { type: "array", items: { type: "string" } },
                  },
                },
              },
              timeout: scrapeTimeout * 2, // takes a while to run, LLM
            },
            identity,
          );

          expect(response.changeTracking).toBeDefined();
          expect(response.changeTracking?.previousScrapeAt).not.toBeNull();

          if (response.changeTracking?.changeStatus === "changed") {
            expect(response.changeTracking?.diff).toBeDefined();
            expect(response.changeTracking?.diff?.text).toBeDefined();
            expect(response.changeTracking?.diff?.json).toBeDefined();

            expect(response.changeTracking?.json).toBeDefined();
            expect(response.changeTracking?.json).toHaveProperty("summary");
            expect(response.changeTracking?.json).toHaveProperty("changes");
          }
        },
        scrapeTimeout * 2,
      );

      it.concurrent(
        "supports tags properly",
        async () => {
          const uuid1 = crypto.randomUUID();
          const uuid2 = crypto.randomUUID();

          const response1 = await scrape(
            {
              url: base,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: { tag: uuid1 },
              timeout: scrapeTimeout,
            },
            identity,
          );

          const response2 = await scrape(
            {
              url: base,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: { tag: uuid2 },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response1.changeTracking?.previousScrapeAt).toBeNull();
          expect(response1.changeTracking?.changeStatus).toBe("new");
          expect(response2.changeTracking?.previousScrapeAt).toBeNull();
          expect(response2.changeTracking?.changeStatus).toBe("new");

          const response3 = await scrape(
            {
              url: base,
              formats: ["markdown", "changeTracking"],
              changeTrackingOptions: { tag: uuid1 },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response3.changeTracking?.previousScrapeAt).not.toBeNull();
          expect(response3.changeTracking?.changeStatus).not.toBe("new");
        },
        scrapeTimeout * 3,
      );
    });

    describe("Location API (f-e dependant)", () => {
      it.concurrent(
        "works without specifying an explicit location",
        async () => {
          await scrape(
            {
              url: "https://iplocation.com",
              timeout: scrapeTimeout,
            },
            identity,
          );
        },
        scrapeTimeout,
      );

      it.concurrent(
        "works with country US",
        async () => {
          const response = await scrape(
            {
              url: "https://iplocation.com",
              location: { country: "US" },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response.markdown).toContain("| Country | United States |");
        },
        scrapeTimeout,
      );
    });

    describe("Screenshot (f-e dependant)", () => {
      it.concurrent(
        "screenshot format works",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["screenshot"],
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(typeof response.screenshot).toBe("string");
        },
        scrapeTimeout,
      );

      it.concurrent(
        "screenshot@fullPage format works",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["screenshot@fullPage"],
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(typeof response.screenshot).toBe("string");
        },
        scrapeTimeout,
      );
    });

    describe("PDF generation (f-e dependant)", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: base,
              timeout: scrapeTimeout,
              actions: [{ type: "pdf" }],
            },
            identity,
          );

          expect(response.actions?.pdfs).toBeDefined();
          expect(response.actions?.pdfs?.length).toBe(1);
          expect(response.actions?.pdfs?.[0]).toBeDefined();
          expect(typeof response.actions?.pdfs?.[0]).toBe("string");
        },
        scrapeTimeout,
      );
    });

    describe("Proxy API (f-e dependant)", () => {
      it.concurrent(
        "undefined works",
        async () => {
          await scrape(
            {
              url: base,
              timeout: scrapeTimeout,
            },
            identity,
          );
        },
        scrapeTimeout,
      );

      it.concurrent(
        "basic works",
        async () => {
          await scrape(
            {
              url: base,
              proxy: "basic",
              timeout: scrapeTimeout,
            },
            identity,
          );
        },
        scrapeTimeout,
      );

      it.concurrent(
        "stealth works",
        async () => {
          await scrape(
            {
              url: base,
              proxy: "stealth",
              timeout: scrapeTimeout * 2,
            },
            identity,
          );
        },
        scrapeTimeout * 2,
      );

      it.concurrent(
        "auto works properly on non-stealth site",
        async () => {
          const res = await scrape(
            {
              url: base,
              proxy: "auto",
              timeout: scrapeTimeout * 2,
            },
            identity,
          );

          expect(res.metadata.proxyUsed).toBe("basic");
        },
        scrapeTimeout * 2,
      );

      // TODO: flaky
      // it.concurrent("auto works properly on 'stealth' site (faked for reliabile testing)", async () => {
      //   const res = await scrape({
      //     url: "https://eo16f6718vph4un.m.pipedream.net", // always returns 403
      //     proxy: "auto",
      //     timeout: scrapeTimeout * 2,
      //   }, identity);

      //   expect(res.metadata.proxyUsed).toBe("stealth");
      // }, scrapeTimeout * 2);
    });

    describe("PDF (f-e dependant)", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: "https://www.orimi.com/pdf-test.pdf",
              timeout: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response.markdown).toContain("PDF Test File");
          expect(response.metadata.title).toBe("PDF Test Page");
          expect(response.metadata.numPages).toBe(1);
        },
        scrapeTimeout * 2,
      );

      // Temporarily disabled, too flaky
      // it.concurrent("works for PDFs behind anti-bot", async () => {
      //   const response = await scrape({
      //     url: "https://www.researchgate.net/profile/Amir-Leshem/publication/220732050_Robust_adaptive_beamforming_based_on_jointly_estimating_covariance_matrix_and_steering_vector/links/0c96052d2fd8f0a84b000000/Robust-adaptive-beamforming-based-on-jointly-estimating-covariance-matrix-and-steering-vector.pdf"
      //   });

      //   expect(response.markdown).toContain("Robust adaptive beamforming based on jointly estimating covariance matrix");
      // }, 60000);

      it.concurrent(
        "blocks long PDFs with insufficient timeout",
        async () => {
          const response = await scrapeWithFailure(
            {
              url: `${base}/example-long.pdf`,
              timeout: 10000,
            },
            identity,
          );

          expect(response.error).toContain("Insufficient time to process PDF");
        },
        12000,
      );

      it.concurrent(
        "scrapes long PDFs with sufficient timeout",
        async () => {
          const response = await scrape(
            {
              url: `${base}/example-long.pdf`,
              timeout: scrapeTimeout * 5,
            },
            identity,
          );

          // text on the last page
          expect(response.markdown).toContain(
            "Redistribution and use in source and binary forms, with or without modification",
          );
        },
        scrapeTimeout * 5,
      );
    });
  });

  // TODO: do these require FE?
  describe("URL rewriting", () => {
    concurrentIf(TEST_PRODUCTION)(
      "scrapes Google Docs links as PDFs",
      async () => {
        const response = await scrape(
          {
            url: "https://docs.google.com/document/d/1H-hOLYssS8xXl2o5hxj4ipE7yyhZAX1s7ADYM1Hdlzo/view",
          },
          identity,
        );

        expect(response.markdown).toContain(
          "This is a test to confirm Google Docs scraping abilities.",
        );
      },
      scrapeTimeout * 5,
    );

    concurrentIf(TEST_PRODUCTION)(
      "scrapes Google Slides links as PDFs",
      async () => {
        const response = await scrape(
          {
            url: "https://docs.google.com/presentation/d/1pDKL1UULpr6siq_eVWE1hjqt5MKCgSSuKS_MWahnHAQ/view",
          },
          identity,
        );

        expect(response.markdown).toContain(
          "This is a test to confirm Google Slides scraping abilities.",
        );
      },
      scrapeTimeout * 5,
    );

    concurrentIf(TEST_PRODUCTION)(
      "scrapes Google Drive PDF files as PDFs",
      async () => {
        const response = await scrape(
          {
            url: "https://drive.google.com/file/d/1QrgvXM2F7sgSdrhoBfdp9IMBVhUk-Ueu/view?usp=drive_link",
          },
          identity,
        );

        expect(response.markdown).toContain("This is a simple PDF file.");
      },
      scrapeTimeout * 5,
    );

    concurrentIf(TEST_PRODUCTION)(
      "scrapes Google Drive text files correctly",
      async () => {
        const response = await scrape(
          {
            url: "https://drive.google.com/file/d/14m3ZVDnWJwwPSDHX6U6jkL7FXxOf6cHB/view?usp=sharing",
          },
          identity,
        );

        expect(response.markdown).toContain("This is a simple TXT file.");
      },
      scrapeTimeout * 5,
    );

    concurrentIf(TEST_PRODUCTION)(
      "scrapes Google Sheets links correctly",
      async () => {
        const response = await scrape(
          {
            url: "https://docs.google.com/spreadsheets/d/1DTpw_bbsf3OY17ZqEYEpW6lAmLdCRC2WfLrV0isG9ac/edit?usp=sharing",
          },
          identity,
        );

        expect(response.markdown).toContain("This is a test sheet.");
      },
      scrapeTimeout * 5,
    );
  });

  describeIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "JSON format",
    () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: base,
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
                  required: [
                    "company_mission",
                    "supports_sso",
                    "is_open_source",
                  ],
                },
              },
              timeout: scrapeTimeout,
            },
            identity,
          );

          expect(response).toHaveProperty("json");
          expect(response.json).toHaveProperty("company_mission");
          expect(typeof response.json.company_mission).toBe("string");
          expect(response.json).toHaveProperty("supports_sso");
          expect(response.json.supports_sso).toBe(false);
          expect(typeof response.json.supports_sso).toBe("boolean");
          expect(response.json).toHaveProperty("is_open_source");
          expect(response.json.is_open_source).toBe(true);
          expect(typeof response.json.is_open_source).toBe("boolean");
        },
        scrapeTimeout,
      );
    },
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "sourceURL stays unnormalized",
    async () => {
      const response = await scrape(
        {
          url: base,
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.metadata.sourceURL).toBe(base);
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "application/json content type is markdownified properly",
    async () => {
      const response = await scrape(
        {
          url: `${base}/example.json`,
          formats: ["markdown"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown).toContain("```json");
    },
    scrapeTimeout,
  );

  // TODO: check if these are required
  describe("__experimental_omceDomain functionality", () => {
    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "should accept __experimental_omceDomain flag in scrape request",
      async () => {
        const response = await scrape(
          {
            url: base, // Previously: https://httpbin.org/html
            __experimental_omceDomain: "fake-domain.com",
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.metadata).toBeDefined();
      },
      scrapeTimeout,
    );

    concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
      "should work with __experimental_omceDomain and other experimental flags",
      async () => {
        const response = await scrape(
          {
            url: base, // Previously: https://httpbin.org/html
            __experimental_omceDomain: "test-domain.org",
            __experimental_omce: true,
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.metadata).toBeDefined();
      },
      scrapeTimeout,
    );
  });

  describe("Schema validation for additionalProperties", () => {
    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should normalize scrape request with additionalProperties in extract schema",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: ["extract"],
            extract: {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should normalize extract request with additionalProperties in schema",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await extract(
          {
            urls: [base],
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
              additionalProperties: true,
            },
            origin: "api-sdk",
          },
          identity,
        );

        expect(response.success).toBe(true);
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should normalize scrape request with nested additionalProperties",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: ["extract"],
            extract: {
              schema: {
                type: "object",
                properties: {
                  user: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
              },
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should accept valid schema without additionalProperties",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: ["extract"],
            extract: {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
                required: ["title"],
              },
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION)(
      "should normalize changeTracking with additionalProperties in schema",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: ["markdown", "changeTracking"],
            changeTrackingOptions: {
              schema: {
                type: "object",
                properties: {
                  changes: { type: "string" },
                },
                additionalProperties: true,
              },
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should reject schema-less dictionary (no properties but additionalProperties: true)",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: ["extract"],
            extract: {
              schema: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain("OpenAI");
        expect(response.body.error).toContain("schema-less dictionary");
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should normalize scrape request with object type without properties (but no additionalProperties)",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: ["extract"],
            extract: {
              schema: {
                type: "object",
                properties: {
                  address: { type: "string" },
                  detail: {
                    type: "object",
                    description:
                      "Any other specifications of the particular make and model in the page",
                  },
                },
              },
            },
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );
  });
});
