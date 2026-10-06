import { getCostTrackingCalls } from "../cost-tracking-helpers";
import { concurrentIf, HAS_XAI, TEST_PRODUCTION } from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-x-twitter",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// X/Twitter scrapes go through xAI's X Search, which bills per profile and
// post fetched.
describe("X/Twitter profile scrape", () => {
  concurrentIf(TEST_PRODUCTION && HAS_XAI)(
    "returns the profile and its latest posts from a single profile lookup",
    async () => {
      const response = await scrape(
        { url: "https://x.com/NASA", timeout: scrapeTimeout },
        identity,
      );

      expect(response.markdown).toMatch(/^# .+ \(@NASA\)$/im);
      expect(response.markdown).toContain("## Latest Posts");
      expect(response.markdown).toContain("### 1. Post");

      const calls = await getCostTrackingCalls(response.metadata.scrapeId!);
      const profileCalls = calls.filter(
        call => call.metadata?.method === "xTwitter/profile",
      );
      expect(profileCalls).toHaveLength(1);
      expect(profileCalls[0].metadata.xSearchProfiles).toBeLessThanOrEqual(1);
    },
    scrapeTimeout + 15000,
  );

  concurrentIf(TEST_PRODUCTION && HAS_XAI)(
    "does not substitute another account for a nonexistent handle",
    async () => {
      // Letters and digits only, so the handle survives markdown escaping.
      const handle = `fcnx${Math.random().toString(36).slice(2, 12)}`;
      const response = await scrape(
        { url: `https://x.com/${handle}`, timeout: scrapeTimeout },
        identity,
      );

      expect(response.markdown).toMatch(
        new RegExp(`^# .+ \\(@(unknown|${handle})\\)$`, "im"),
      );
      expect(response.markdown).toContain(
        "No recent top-level posts were returned.",
      );
      expect(response.markdown).not.toContain("### 1. Post");
    },
    scrapeTimeout + 15000,
  );
});
