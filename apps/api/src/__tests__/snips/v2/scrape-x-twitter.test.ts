import { config } from "../../../config";
import { concurrentIf, TEST_PRODUCTION } from "../lib";
import { scrape, scrapeRaw, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-x-twitter",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// X/Twitter posts and profiles are served by the Exchange's X provider, the
// same route LinkedIn profiles take, for every team.
const HAS_EXCHANGE_X = TEST_PRODUCTION && !!config.FIRE_EXCHANGE_URL;

describe("X/Twitter scrape through the Exchange", () => {
  concurrentIf(HAS_EXCHANGE_X)(
    "returns the profile at the Exchange's price",
    async () => {
      const response = await scrape(
        { url: "https://x.com/NASA", timeout: scrapeTimeout },
        identity,
      );

      expect(response.markdown).toMatch(/nasa/i);
      expect(response.metadata.creditsUsed).toBe(5);
    },
    scrapeTimeout + 15000,
  );

  concurrentIf(HAS_EXCHANGE_X)(
    "returns a post at the Exchange's price",
    async () => {
      const response = await scrape(
        {
          url: "https://x.com/ericciarla/status/2037202150690844778",
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.markdown).toContain("2037202150690844778");
      expect(response.markdown).toMatch(/n8n/i);
      expect(response.metadata.creditsUsed).toBe(5);
    },
    scrapeTimeout + 15000,
  );

  concurrentIf(HAS_EXCHANGE_X)(
    "reports a nonexistent handle as a missing record rather than another account",
    async () => {
      // Letters and digits only, so the handle is a valid X username.
      const handle = `fcnx${Math.random().toString(36).slice(2, 12)}`;
      const response = await scrapeRaw(
        { url: `https://x.com/${handle}`, timeout: scrapeTimeout },
        identity,
      );

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("THIRD_PARTY_DATA_NOT_FOUND");
    },
    scrapeTimeout + 15000,
  );
});
