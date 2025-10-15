import { search, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "search",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Search tests", () => {
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
          query: "coconut",
          limit: 5,
          scrapeOptions: {
            formats: ["markdown"],
          },
          timeout: 120000,
        },
        identity,
      );

      for (const doc of res.web ?? []) {
        expect(doc.markdown).toBeDefined();
      }
    },
    125000,
  );

  it.concurrent(
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

  it.concurrent(
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

  it.concurrent(
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

  it.concurrent(
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

  it.concurrent(
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

  it.concurrent(
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
});
