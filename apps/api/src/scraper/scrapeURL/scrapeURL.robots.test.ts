import "dotenv/config";

import { config } from "../../config";
config.ENV = "test";

vi.mock("../../lib/robots-txt", () => ({
  fetchRobotsTxt: vi.fn(async () => ({
    content: "User-agent: *\nDisallow: /blocked",
    url: "https://firecrawl-test-site.vercel.app/robots.txt",
  })),

  createRobotsChecker: vi.fn(() => ({
    robotsTxtUrl: "https://firecrawl-test-site.vercel.app/robots.txt",
    robotsTxt: "User-agent: *\nDisallow: /blocked",
    robots: {},
  })),

  isUrlAllowedByRobots: vi.fn(() => false),
}));

import { scrapeURL } from ".";
import { scrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";

describe("scrapeURL robots.txt enforcement", () => {
  it("does not scrape a URL blocked by robots.txt", async () => {
    const out = await scrapeURL(
      "test:robots-blocked",
      "https://firecrawl-test-site.vercel.app/blocked",
      scrapeOptions.parse({}),
      {
        forceEngine: "fetch",
        teamId: "test",
        orgId: null,
        teamFlags: {
          checkRobotsOnScrape: true,
        },
      },
      new CostTracking(),
    );

    expect(out.success).toBe(false);
  }, 30000);
});
