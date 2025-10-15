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
      await search(
        {
          query: "firecrawl",
        },
        identity,
      );
    },
    60000,
  );

  it.concurrent(
    "works with scrape",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 5,
          scrapeOptions: {
            formats: ["markdown"],
          },
          timeout: 120000,
        },
        identity,
      );

      for (const doc of res) {
        expect(doc.markdown).toBeDefined();
      }
    },
    125000,
  );

  it.concurrent(
    "respects limit",
    async () => {
      const res = await search(
        {
          query: "firecrawl",
          limit: 3,
        },
        identity,
      );

      expect(res.length).toBeGreaterThan(0);
      expect(res.length).toBeLessThanOrEqual(3);
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
      expect(res.length).toBeGreaterThan(0);
      expect(res.length).toBeLessThanOrEqual(20);
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
      expect(res.length).toBeGreaterThan(0);
    },
    60000,
  );
});
