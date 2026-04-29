import {
  concurrentIf,
  describeIf,
  HAS_PROXY,
  HAS_SEARCH,
  TEST_PRODUCTION,
} from "../lib";
import { search, idmux, Identity } from "./lib";
import { config } from "../../../config";

const HAS_ARXIV = !!config.ARXIV_SEARCH_URL;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "search",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

// NOTE: if DDG gives us issues with this, we can disable if SEARXNG is not enabled
describeIf(TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY)("Search tests", () => {
  it.concurrent(
    "works",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
    },
    60000,
  );

  it.concurrent(
    "works with scrape",
    async () => {
      const res = await search(
        {
          query: "firecrawl.dev",
          limit: 5,
          scrapeOptions: {
            formats: ["markdown"],
          },
          timeout: 120000,
        },
        identity,
      );

      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);

      let markdownCount = 0;

      for (const doc of res.web ?? []) {
        if (doc.markdown) {
          markdownCount += 1;
        } else {
          // Search can return URLs that are not consistently scrapeable in test environments,
          // so log the failing entries to make partial scrape failures easier to debug.
          console.warn("Search scrape result missing markdown", {
            url: doc.url,
            error: doc.metadata?.error,
            statusCode: doc.metadata?.statusCode,
          });
          expect(doc.metadata?.error).toBeDefined();
        }
      }

      expect(markdownCount).toBeGreaterThan(0);
    },
    125000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "works for news",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["news"],
        },
        identity,
      );
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "works for images",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["images"],
        },
        identity,
      );
      expect(res.images).toBeDefined();
      expect(res.images?.length).toBeGreaterThan(0);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "works for multiple sources",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["web", "news", "images"],
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.images).toBeDefined();
      expect(res.images?.length).toBeGreaterThan(0);
    },
    60000,
  );

  it.concurrent(
    "respects limit for web",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 3,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(3);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "respects limit for news",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["news"],
          limit: 2,
        },
        identity,
      );
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.news?.length).toBeLessThanOrEqual(2);
    },
    60000,
  );

  it.concurrent(
    "respects limit for above 10",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 20,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(20);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "respects limit for above 10 images",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["images"],
          limit: 20,
        },
        identity,
      );
      expect(res.images).toBeDefined();
      expect(res.images?.length).toBeGreaterThan(0);
      expect(res.images?.length).toBeLessThanOrEqual(20);
    },
    60000,
  );

  concurrentIf(TEST_PRODUCTION)(
    "respects limit for above 10 multiple sources",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          sources: ["web", "news"],
          limit: 20,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(20);
      expect(res.news).toBeDefined();
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.news?.length).toBeLessThanOrEqual(20);
    },
    60000,
  );

  it.concurrent(
    "country defaults to undefined when location is set",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          location: "San Francisco",
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
    },
    60000,
  );

  // SEARXNG-specific pagination tests
  concurrentIf(!!config.SEARXNG_ENDPOINT)(
    "searxng respects limit of 2 results",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 2,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(2);
    },
    60000,
  );

  concurrentIf(!!config.SEARXNG_ENDPOINT)(
    "searxng fetches multiple pages for 21 results",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 21,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(21);
    },
    60000,
  );

  // Arxiv category tests — these require the internal ARXIV_SEARCH_URL env var
  // to be set, which points at the private arxiv retrieval service. When the
  // URL is not configured the category becomes a no-op and these tests are skipped.
  concurrentIf(HAS_ARXIV && (TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY))(
    "works with arxiv category",
    async () => {
      const res = await search(
        {
          query: "retrieval augmented generation",
          categories: ["arxiv"],
          limit: 5,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);

      const arxivHits = (res.web ?? []).filter(r => r.category === "arxiv");
      expect(arxivHits.length).toBeGreaterThan(0);
      for (const hit of arxivHits) {
        expect(hit.url).toMatch(/^https?:\/\/([^/]+\.)?arxiv\.org\//);
        expect(typeof hit.title).toBe("string");
        expect(hit.title.length).toBeGreaterThan(0);
      }
    },
    60000,
  );

  concurrentIf(HAS_ARXIV && (TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY))(
    "works with arxiv category combined with github",
    async () => {
      const res = await search(
        {
          query: "retrieval augmented generation",
          categories: ["arxiv", "github"],
          limit: 10,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);

      const categories = new Set(
        (res.web ?? [])
          .map(r => r.category)
          .filter((c): c is string => Boolean(c)),
      );
      // We don't require github results in every environment (DDG fallbacks
      // can be flaky), but arxiv must come back from the dedicated API.
      expect(categories.has("arxiv")).toBe(true);
    },
    60000,
  );

  concurrentIf(HAS_ARXIV && (TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY))(
    "respects limit when arxiv category is selected",
    async () => {
      const res = await search(
        {
          query: "retrieval augmented generation",
          categories: ["arxiv"],
          limit: 3,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web?.length).toBeLessThanOrEqual(3);
    },
    60000,
  );

  concurrentIf(HAS_ARXIV && (TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY))(
    "arxiv category works with advanced object format",
    async () => {
      const res = await search(
        {
          query: "retrieval augmented generation",
          categories: [{ type: "arxiv" }],
          limit: 5,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      const arxivHits = (res.web ?? []).filter(r => r.category === "arxiv");
      expect(arxivHits.length).toBeGreaterThan(0);
    },
    60000,
  );

  // A happy-path failure test that runs everywhere: when arxiv is selected but
  // the internal service is not configured, the endpoint must still respond
  // successfully (just without arxiv-tagged results).
  concurrentIf(!HAS_ARXIV && (TEST_PRODUCTION || HAS_SEARCH || HAS_PROXY))(
    "arxiv category is a no-op when ARXIV_SEARCH_URL is not configured",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          categories: ["arxiv"],
          limit: 5,
        },
        identity,
      );
      expect(res.web).toBeDefined();
      const arxivHits = (res.web ?? []).filter(r => r.category === "arxiv");
      expect(arxivHits.length).toBe(0);
    },
    60000,
  );
});
