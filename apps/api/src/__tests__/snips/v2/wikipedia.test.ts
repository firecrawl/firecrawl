import { describeIf } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

const HAS_WIKIPEDIA = !!(
  process.env.WIKIPEDIA_ENTERPRISE_USERNAME &&
  process.env.WIKIPEDIA_ENTERPRISE_PASSWORD
);

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "wikipedia",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describeIf(HAS_WIKIPEDIA && !process.env.TEST_SUITE_SELF_HOSTED)(
  "Wikipedia Enterprise API integration",
  () => {
    describe("basic scraping", () => {
      it.concurrent(
        "scrapes a Wikipedia article and returns markdown by default",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/Web_scraping",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.metadata.statusCode).toBe(200);
          expect(response.metadata.sourceURL).toBe(
            "https://en.wikipedia.org/wiki/Web_scraping",
          );
        },
        scrapeTimeout,
      );

      it.concurrent(
        "scrapes a non-English Wikipedia article (Spanish)",
        async () => {
          const response = await scrape(
            {
              url: "https://es.wikipedia.org/wiki/Web_scraping",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(50);
          expect(response.metadata.statusCode).toBe(200);
        },
        scrapeTimeout,
      );

      it.concurrent(
        "scrapes a non-English Wikipedia article (French)",
        async () => {
          const response = await scrape(
            {
              url: "https://fr.wikipedia.org/wiki/France",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.metadata.statusCode).toBe(200);
        },
        scrapeTimeout,
      );
    });

    describe("redirect handling", () => {
      it.concurrent(
        "handles Wikipedia redirect pages (e.g. Brasil -> Brazil)",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/Brasil",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.metadata.statusCode).toBe(200);
        },
        scrapeTimeout,
      );

      it.concurrent(
        "handles abbreviation redirects (e.g. UK -> United Kingdom)",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/UK",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.metadata.statusCode).toBe(200);
        },
        scrapeTimeout,
      );
    });

    describe("special characters", () => {
      it.concurrent(
        "handles URL-encoded special characters (C++)",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/C%2B%2B",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.metadata.statusCode).toBe(200);
        },
        scrapeTimeout,
      );

      it.concurrent(
        "handles articles with parentheses (disambiguation)",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/Mercury_(planet)",
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.metadata.statusCode).toBe(200);
        },
        scrapeTimeout,
      );
    });

    describe("output formats", () => {
      it.concurrent(
        "returns markdown when format is markdown",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["markdown"],
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.markdown).toContain("TypeScript");
          expect(response.html).toBeUndefined();
          expect(response.rawHtml).toBeUndefined();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "returns html when format is html",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["html"],
            },
            identity,
          );

          expect(response.html).toBeTruthy();
          expect(response.html!.length).toBeGreaterThan(100);
          expect(response.html).toContain("TypeScript");
          expect(response.markdown).toBeUndefined();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "returns rawHtml when format is rawHtml",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["rawHtml"],
            },
            identity,
          );

          expect(response.rawHtml).toBeTruthy();
          expect(response.rawHtml!.length).toBeGreaterThan(100);
          expect(response.rawHtml).toContain("TypeScript");
          expect(response.markdown).toBeUndefined();
        },
        scrapeTimeout,
      );

      it.concurrent(
        "returns links when format is links",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["links"],
            },
            identity,
          );

          expect(response.links).toBeTruthy();
          expect(Array.isArray(response.links)).toBe(true);
          expect(response.links!.length).toBeGreaterThan(0);
        },
        scrapeTimeout,
      );

      it.concurrent(
        "returns multiple formats together",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["markdown", "html", "links"],
            },
            identity,
          );

          expect(response.markdown).toBeTruthy();
          expect(response.html).toBeTruthy();
          expect(response.links).toBeTruthy();
          expect(response.markdown!.length).toBeGreaterThan(100);
          expect(response.html!.length).toBeGreaterThan(100);
          expect(response.links!.length).toBeGreaterThan(0);
        },
        scrapeTimeout,
      );
    });

    describe("metadata", () => {
      it.concurrent(
        "returns correct metadata for a Wikipedia article",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["markdown"],
            },
            identity,
          );

          expect(response.metadata).toBeDefined();
          expect(response.metadata.statusCode).toBe(200);
          expect(response.metadata.sourceURL).toBe(
            "https://en.wikipedia.org/wiki/TypeScript",
          );
          expect(response.metadata.title).toBeTruthy();
          expect(response.metadata.description).toBeTruthy();
        },
        scrapeTimeout,
      );
    });

    describe("og:image metadata", () => {
      it.concurrent(
        "includes og:image in metadata and rawHtml for articles with an image",
        async () => {
          const response = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/Military",
              formats: ["rawHtml"],
            },
            identity,
          );

          expect(response.metadata.statusCode).toBe(200);
          expect(response.metadata.ogImage).toBeTruthy();
          expect(response.metadata.ogImage).toMatch(/^https?:\/\//);
          expect(response.rawHtml).toContain('property="og:image"');
        },
        scrapeTimeout,
      );
    });

    describe("error handling", () => {
      it.concurrent(
        "fails gracefully for non-existent Wikipedia article",
        async () => {
          const response = await scrapeRaw(
            {
              url: "https://en.wikipedia.org/wiki/ThisArticleDefinitelyDoesNotExist_XYZZY_123456789",
            },
            identity,
          );

          expect(response.statusCode).not.toBe(200);
        },
        scrapeTimeout,
      );
    });

    describe("scrape options", () => {
      it.concurrent(
        "respects onlyMainContent option",
        async () => {
          const withMainContent = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["markdown"],
              onlyMainContent: true,
            },
            identity,
          );

          const withoutMainContent = await scrape(
            {
              url: "https://en.wikipedia.org/wiki/TypeScript",
              formats: ["markdown"],
              onlyMainContent: false,
            },
            identity,
          );

          expect(withMainContent.markdown).toBeTruthy();
          expect(withoutMainContent.markdown).toBeTruthy();
          // Full content should be equal to or longer than main-only content
          expect(withoutMainContent.markdown!.length).toBeGreaterThanOrEqual(
            withMainContent.markdown!.length,
          );
        },
        scrapeTimeout * 2,
      );
    });
  },
);
