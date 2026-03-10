import { config } from "../../../config";
import {
  createTestIdUrl,
  describeIf,
  concurrentIf,
  itIf,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  HAS_FIRE_ENGINE,
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
  extractRaw,
  TEST_API_URL,
} from "./lib";
import request from "./lib";
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
        },
        identity,
      );

      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  describeIf(ALLOW_TEST_SUITE_WEBSITE)("waitFor validation", () => {
    it.concurrent(
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

    it.concurrent(
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

    it.concurrent(
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

  it.concurrent(
    "returns 400 for invalid URL",
    async () => {
      const raw = await scrapeRaw(
        {
          url: "not-a-valid-url",
        } as any,
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  // TEMP: domain broken
  // it.concurrent("works with Punycode domains", async () => {
  //   await scrape({
  //     url: "http://xn--1lqv92a901a.xn--ses554g/",
  //   }, identity);
  // }, scrapeTimeout);

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "handles non-UTF-8 encodings",
    async () => {
      const response = await scrape(
        {
          url: `${base}/blog/unicode-post`,
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
      },
      identity,
    );

    expect(response.links).toBeDefined();
    expect(response.links?.length).toBeGreaterThan(0);
  });

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)("images format works", async () => {
    const response = await scrape(
      {
        url: `${base}/blog`,
        formats: ["images"],
      },
      identity,
    );

    expect(response.images).toBeDefined();
    expect(response.images?.length).toBeGreaterThan(0);
    // Firecrawl website should have at least the logo
    expect(response.images?.some(img => img.includes("firecrawl"))).toBe(true);
  });

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "images format works with multiple formats",
    async () => {
      const response = await scrape(
        {
          url: `${base}/blog`,
          formats: ["markdown", "links", "images"],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.links).toBeDefined();
      expect(response.images).toBeDefined();
      expect(response.images?.length).toBeGreaterThan(0);

      // Images should include things that aren't in links
      const imageExtensions = [
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
      ];
      const linkImages =
        response.links?.filter(link =>
          imageExtensions.some(ext => link.toLowerCase().includes(ext)),
        ) || [];

      // Should have found more images than just those with obvious extensions in links
      expect(response.images?.length).toBeGreaterThanOrEqual(linkImages.length);
    },
  );

  concurrentIf(TEST_SELF_HOST && HAS_PROXY)(
    "self-hosted proxy works",
    async () => {
      const response = await scrape(
        {
          url: "https://icanhazip.com",
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
        },
        identity,
      );

      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  itIf(TEST_SELF_HOST && !HAS_FIRE_ENGINE)(
    "rejects actions when fire-engine is not configured",
    async () => {
      const raw = await scrapeRaw(
        {
          url: "https://example.com",
          actions: [
            {
              type: "wait",
              milliseconds: 1000,
            },
          ],
        },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
      expect(raw.body.code).toBe("SCRAPE_ACTIONS_NOT_SUPPORTED");
      expect(raw.body.error).toContain("Actions are not supported");
    },
    scrapeTimeout,
  );

  describeIf(ALLOW_TEST_SUITE_WEBSITE)("JSON scrape support", () => {
    it.concurrent(
      "returns parseable JSON",
      async () => {
        const response = await scrape(
          {
            url: `${base}/example.json`,
            formats: ["rawHtml"],
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

    describe("Ad blocking (f-e dependent)", () => {
      it.concurrent(
        "blocking ads works",
        async () => {
          await scrape(
            {
              url: base,
              blockAds: true,
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
          const url = createTestIdUrl();

          const response1 = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 3,
              storeInCache: false,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 3,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response3 = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 3,
            },
            identity,
          );

          expect(response3.metadata.cacheState).toBe("hit");
          expect(response3.metadata.cachedAt).toBeDefined();

          const response4 = await scrape(
            {
              url,
              maxAge: 1,
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
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
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
              maxAge: 0,
            },
            identity,
          );

          expect(response1.screenshot).toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              formats: ["screenshot"],
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response2.screenshot).toBe(response1.screenshot);

          const response3 = await scrape(
            {
              url,
              formats: [{ type: "screenshot", fullPage: true }],
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
              formats: [{ type: "screenshot", fullPage: true }],
              maxAge: 0,
            },
            identity,
          );

          expect(response1.screenshot).toBeDefined();

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              formats: [{ type: "screenshot", fullPage: true }],
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response2.screenshot).toBe(response1.screenshot);

          const response3 = await scrape(
            {
              url,
              formats: ["screenshot"],
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
              maxAge: 0,
            },
            identity,
          );

          const response1 = await scrape(
            {
              url,
              formats: ["markdown", "changeTracking"],
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
              maxAge: 0,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response = await scrape(
            {
              url,
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
              maxAge: 0,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response1 = await scrape(
            {
              url,
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
              maxAge: 0,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response1 = await scrape(
            {
              url,
              location: { country: "DE", languages: ["hu-HU", "de-DE"] },
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response1.metadata.cacheState).toBe("miss");

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response2 = await scrape(
            {
              url,
              location: { country: "DE", languages: ["de-DE", "hu-HU"] },
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
              maxAge: 0,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response0 = await scrape(
            {
              url,
              blockAds: true,
              maxAge: scrapeTimeout * 2 + indexCooldown,
            },
            identity,
          );

          expect(response0.metadata.cacheState).toBe("hit");

          const response1 = await scrape(
            {
              url,
              blockAds: false,
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
              maxAge: scrapeTimeout * 2 + indexCooldown,
            },
            identity,
          );

          expect(response2.metadata.cacheState).toBe("hit");

          const response3 = await scrape(
            {
              url,
              proxy: "stealth",
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
              maxAge: 0,
            },
            identity,
          );

          await new Promise(resolve => setTimeout(resolve, indexCooldown));

          const response = await scrape(
            {
              url,
              maxAge: scrapeTimeout * 2,
            },
            identity,
          );

          expect(response.metadata.cacheState).toBe("hit");
        },
        scrapeTimeout * 2 + 1 * indexCooldown,
      );
    });

    describe("Change Tracking format (f-e dependent)", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: CHANGE_TRACKING_TEST_URL,
              formats: ["markdown", "changeTracking"],
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
              formats: [
                "markdown",
                { type: "changeTracking", modes: ["git-diff"] },
              ],
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
              url: CHANGE_TRACKING_TEST_URL,
              formats: [
                "markdown",
                {
                  type: "changeTracking",
                  modes: ["json"],
                  prompt:
                    "Summarize the changes between the previous and current content",
                },
              ],
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
              url: CHANGE_TRACKING_TEST_URL,
              formats: [
                "markdown",
                {
                  type: "changeTracking",
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
              ],
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
              url: CHANGE_TRACKING_TEST_URL,
              formats: [
                "markdown",
                {
                  type: "changeTracking",
                  modes: ["git-diff", "json"],
                  schema: {
                    type: "object",
                    properties: {
                      summary: { type: "string" },
                      changes: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              ],
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
              url: CHANGE_TRACKING_TEST_URL,
              formats: ["markdown", { type: "changeTracking", tag: uuid1 }],
            },
            identity,
          );

          const response2 = await scrape(
            {
              url: CHANGE_TRACKING_TEST_URL,
              formats: ["markdown", { type: "changeTracking", tag: uuid2 }],
            },
            identity,
          );

          expect(response1.changeTracking?.previousScrapeAt).toBeNull();
          expect(response1.changeTracking?.changeStatus).toBe("new");
          expect(response2.changeTracking?.previousScrapeAt).toBeNull();
          expect(response2.changeTracking?.changeStatus).toBe("new");

          const response3 = await scrape(
            {
              url: CHANGE_TRACKING_TEST_URL,
              formats: ["markdown", { type: "changeTracking", tag: uuid1 }],
            },
            identity,
          );

          expect(response3.changeTracking?.previousScrapeAt).not.toBeNull();
          expect(response3.changeTracking?.changeStatus).not.toBe("new");
        },
        scrapeTimeout * 3,
      );
    });

    describe("Location API (f-e dependent)", () => {
      it.concurrent(
        "works without specifying an explicit location",
        async () => {
          await scrape(
            {
              url: "https://iplocation.com",
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
            },
            identity,
          );

          expect(response.markdown).toContain("| Country | United States |");
        },
        scrapeTimeout,
      );
    });

    describe("Screenshot (f-e dependent)", () => {
      it.concurrent(
        "screenshot format works",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["screenshot"],
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
              formats: [{ type: "screenshot", fullPage: true }],
            },
            identity,
          );

          expect(typeof response.screenshot).toBe("string");
        },
        scrapeTimeout,
      );
    });

    describe("PDF generation (f-e dependent)", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: base,
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

    describe("Proxy API (f-e dependent)", () => {
      it.concurrent(
        "undefined works",
        async () => {
          await scrape(
            {
              url: base,
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
      //   }, identity);

      //   expect(res.metadata.proxyUsed).toBe("stealth");
      // }, scrapeTimeout * 2);
    });

    describe("PDF (f-e dependent)", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await scrape(
            {
              url: "https://www.orimi.com/pdf-test.pdf",
              maxAge: 0,
            },
            identity,
          );

          expect(response.markdown).toContain("PDF Test File");
          expect(response.metadata.title).toBe("PDF Test Page");
          expect(response.metadata.numPages).toBe(1);
        },
        scrapeTimeout,
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
              maxAge: 0,
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
              maxAge: 0,
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

      it.concurrent(
        "scrapes long PDFs with default timeout",
        async () => {
          const response = await scrape(
            {
              url: `${base}/example-long.pdf`,
              maxAge: 0,
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

    describe("YouTube (f-e dependent)", () => {
      it.concurrent(
        "scrapes YouTube videos and transcripts",
        async () => {
          const response = await scrape(
            {
              url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              formats: ["markdown"],
            },
            identity,
          );

          expect(response.markdown).toContain("Rick Astley");
          expect(response.markdown).toContain("Never gonna let you down");
        },
        scrapeTimeout,
      );
    });
  });

  describe("URL rewriting", () => {
    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "scrapes Google Drive text files correctly",
      async () => {
        const response = await scrape(
          {
            url: "https://drive.google.com/file/d/14m3ZVDnWJwwPSDHX6U6jkL7FXxOf6cHB/view?usp=sharing",
            maxAge: 0,
          },
          identity,
        );

        expect(response.markdown).toContain("This is a simple TXT file.");
      },
      scrapeTimeout * 5,
    );

    concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
      "scrapes Google Sheets links correctly",
      async () => {
        const response = await scrape(
          {
            url: "https://docs.google.com/spreadsheets/d/1DTpw_bbsf3OY17ZqEYEpW6lAmLdCRC2WfLrV0isG9ac/edit?usp=sharing",
            maxAge: 0,
          },
          identity,
        );

        expect(response.markdown).toContain("This is a test sheet.");
      },
      scrapeTimeout * 5,
    );

    concurrentIf(TEST_PRODUCTION)(
      "scrapes Google Docs links as PDFs",
      async () => {
        const response = await scrape(
          {
            url: "https://docs.google.com/document/d/1H-hOLYssS8xXl2o5hxj4ipE7yyhZAX1s7ADYM1Hdlzo/view",
            maxAge: 0,
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
            maxAge: 0,
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
            maxAge: 0,
          },
          identity,
        );

        expect(response.markdown).toContain("This is a simple PDF file.");
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

  describeIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "Summary format",
    () => {
      it.concurrent(
        "generates basic summary with no options required",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["summary"],
            },
            identity,
          );

          expect(response.summary).toBeDefined();
          expect(typeof response.summary).toBe("string");
          expect(response.summary!.length).toBeGreaterThan(10);
        },
        scrapeTimeout,
      );

      it.concurrent(
        "works with markdown format",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["markdown", "summary"],
            },
            identity,
          );

          expect(response.summary).toBeDefined();
          expect(typeof response.summary).toBe("string");
          expect(response.markdown).toBeDefined();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "works alongside json format",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: [
                "summary",
                {
                  type: "json",
                  prompt: "Extract company info as JSON",
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                    },
                  },
                },
              ],
            },
            identity,
          );

          expect(response.summary).toBeDefined();
          expect(typeof response.summary).toBe("string");
          expect(response.json).toBeDefined();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "works with multiple formats",
        async () => {
          const response = await scrape(
            {
              url: base,
              formats: ["markdown", "html", "summary"],
            },
            identity,
          );

          expect(response.summary).toBeDefined();
          expect(typeof response.summary).toBe("string");
          expect(response.markdown).toBeDefined();
          expect(response.html).toBeDefined();
        },
        scrapeTimeout,
      );
    },
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "sourceURL stays unnormalized",
    async () => {
      const url = `${base}?pagewanted=all&et_blog`;
      const response = await scrape(
        {
          url,
        },
        identity,
      );

      expect(response.metadata.sourceURL).toBe(url);
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
        },
        identity,
      );

      expect(response.markdown).toContain("```json");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "nested code blocks are converted to markdown correctly",
    async () => {
      const response = await scrape(
        {
          url: `${base}/code-block`,
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("MyCustomClient");
    },
    scrapeTimeout,
  );

  // TODO: check if these are required
  describeIf(ALLOW_TEST_SUITE_WEBSITE)(
    "__experimental_omceDomain functionality",
    () => {
      it.concurrent(
        "should accept __experimental_omceDomain flag in scrape request",
        async () => {
          const response = await scrape(
            {
              url: base, // Previously: https://httpbin.org/html
              __experimental_omceDomain: "fake-domain.com",
            },
            identity,
          );

          expect(response.markdown).toBeDefined();
          expect(response.metadata).toBeDefined();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "should work with __experimental_omceDomain and other experimental flags",
        async () => {
          const response = await scrape(
            {
              url: base, // Previously: https://httpbin.org/html
              __experimental_omceDomain: "test-domain.org",
              __experimental_omce: true,
            },
            identity,
          );

          expect(response.markdown).toBeDefined();
          expect(response.metadata).toBeDefined();
        },
        scrapeTimeout,
      );
    },
  );
});

// TODO: this is remote, how should we handle this? Production only or also self?
describe("Attribute formats", () => {
  const base = TEST_SUITE_WEBSITE;

  concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
    "should extract attributes from HTML elements",
    async () => {
      const response = await scrape(
        {
          url: "https://news.ycombinator.com",
          formats: [
            { type: "markdown" },
            {
              type: "attributes",
              selectors: [{ selector: ".athing", attribute: "id" }],
            },
          ],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.attributes).toBeDefined();
      expect(Array.isArray(response.attributes)).toBe(true);
      expect(response.attributes!.length).toBe(1);
      expect(response.attributes![0]).toEqual({
        selector: ".athing",
        attribute: "id",
        values: expect.any(Array),
      });
      expect(response.attributes![0].values.length).toBeGreaterThan(0);
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
    "should handle multiple attribute selectors",
    async () => {
      const response = await scrape(
        {
          url: "https://github.com/microsoft/vscode",
          formats: [
            {
              type: "attributes",
              selectors: [
                { selector: "[data-testid]", attribute: "data-testid" },
                {
                  selector: "[data-view-component]",
                  attribute: "data-view-component",
                },
              ],
            },
          ],
        },
        identity,
      );

      expect(response.attributes).toBeDefined();
      expect(Array.isArray(response.attributes)).toBe(true);
      expect(response.attributes!.length).toBe(2);

      const testIdResults = response.attributes!.find(
        a => a.attribute === "data-testid",
      );
      expect(testIdResults).toBeDefined();
      expect(testIdResults!.selector).toBe("[data-testid]");
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_PROXY)(
    "should return empty arrays when no attributes found",
    async () => {
      const response = await scrape(
        {
          url: "https://httpbin.org/html",
          formats: [
            {
              type: "attributes",
              selectors: [{ selector: ".nonexistent", attribute: "data-test" }],
            },
          ],
        },
        identity,
      );

      expect(response.attributes).toBeDefined();
      expect(Array.isArray(response.attributes)).toBe(true);
      expect(response.attributes!.length).toBe(1);
      expect(response.attributes![0].values).toEqual([]);
    },
    scrapeTimeout,
  );

  describe("Schema validation for additionalProperties", () => {
    itIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
      "should normalize scrape request with additionalProperties in json format schema",
      async () => {
        // TODO: how do we want to handle this idmux? Re-fetch or once..?
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            ],
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

        const response = await extractRaw(
          {
            urls: [base],
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
              additionalProperties: true,
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
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                  },
                  required: ["title"],
                },
              },
            ],
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
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            ],
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
      "should normalize schema with object type without properties (but no additionalProperties)",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: [
              {
                type: "json",
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
            ],
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );

    itIf(TEST_PRODUCTION)(
      "should normalize changeTracking format with additionalProperties",
      async () => {
        const identity = await idmux({ name: "schema-validation-test" });

        const response = await scrapeRaw(
          {
            url: base,
            formats: [
              { type: "markdown" },
              {
                type: "changeTracking",
                schema: {
                  type: "object",
                  properties: {
                    changes: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            ],
          },
          identity,
        );

        expect(response.statusCode).toBe(200);
      },
      scrapeTimeout,
    );
  });

  describe("UUID validation", () => {
    it.concurrent(
      "should reject invalid UUID 'None' for scrape status",
      async () => {
        const response = await request(TEST_API_URL)
          .get("/v2/scrape/None")
          .set("Authorization", `Bearer ${identity.apiKey}`)
          .send();

        expect(response.statusCode).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe(
          "Invalid job ID format. Job ID must be a valid UUID.",
        );
      },
    );

    it.concurrent(
      "should reject malformed UUID for scrape status",
      async () => {
        const response = await request(TEST_API_URL)
          .get("/v2/scrape/not-a-valid-uuid")
          .set("Authorization", `Bearer ${identity.apiKey}`)
          .send();

        expect(response.statusCode).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe(
          "Invalid job ID format. Job ID must be a valid UUID.",
        );
      },
    );
  });
});
