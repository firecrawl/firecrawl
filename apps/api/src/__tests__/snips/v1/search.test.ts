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
  it.concurrent("works", async () => {
    await search({
      query: "firecrawl"
    }, identity);
  }, 60000);

  it.concurrent("works with scrape", async () => {
    const res = await search({
      query: "firecrawl",
      limit: 5,
      scrapeOptions: {
        formats: ["markdown"],
      },
      timeout: 120000,
    }, identity);

    for (const doc of res) {
      expect(doc.markdown).toBeDefined();
    }
  }, 125000);
});
