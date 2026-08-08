import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";
config.ENV = "test";

const mocks = vi.hoisted(() => ({
  fetchRobotsTxt: vi.fn(),
  createRobotsChecker: vi.fn(),
  isUrlAllowedByRobots: vi.fn(),
  scrapeURLWithEngine: vi.fn(),
}));

vi.mock("../../lib/robots-txt", () => ({
  fetchRobotsTxt: mocks.fetchRobotsTxt,
  createRobotsChecker: mocks.createRobotsChecker,
  isUrlAllowedByRobots: mocks.isUrlAllowedByRobots,
}));

vi.mock("./engines", async importOriginal => {
  const actual = await importOriginal<typeof import("./engines")>();

  return {
    ...actual,
    scrapeURLWithEngine: mocks.scrapeURLWithEngine,
  };
});

import { scrapeURL } from ".";
import { scrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { CrawlDenialError } from "../../lib/error";

const TEST_URL = "https://firecrawl-test-site.vercel.app/page";

async function runScrape(url = TEST_URL) {
  return scrapeURL(
    "test:robots",
    url,
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
}

describe("scrapeURL robots.txt enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.fetchRobotsTxt.mockResolvedValue({
      content: "User-agent: *\nDisallow: /blocked",
      url: "https://firecrawl-test-site.vercel.app/robots.txt",
    });

    mocks.createRobotsChecker.mockReturnValue({
      robotsTxtUrl: "https://firecrawl-test-site.vercel.app/robots.txt",
      robotsTxt: "User-agent: *\nDisallow: /blocked",
      robots: {},
    });

    mocks.scrapeURLWithEngine.mockResolvedValue({
      url: TEST_URL,
      html: "<html><body>scraped</body></html>",
      markdown: "scraped",
      statusCode: 200,
      proxyUsed: "basic",
    });
  });

  it("does not enter the scraping engine when robots.txt denies the URL", async () => {
    mocks.isUrlAllowedByRobots.mockReturnValue(false);

    const out = await runScrape();

    expect(out.success).toBe(false);

    if (!out.success) {
      expect(out.error).toBeInstanceOf(CrawlDenialError);
    }

    expect(mocks.scrapeURLWithEngine).not.toHaveBeenCalled();
  });

  it("enters the scraping engine when robots.txt allows the URL", async () => {
    mocks.isUrlAllowedByRobots.mockReturnValue(true);

    const out = await runScrape();

    expect(out.success).toBe(true);
    expect(mocks.scrapeURLWithEngine).toHaveBeenCalled();
  });

  it("allows scraping when robots.txt cannot be fetched", async () => {
    mocks.fetchRobotsTxt.mockRejectedValue(
      new Error("Failed to fetch robots.txt"),
    );

    const out = await runScrape();

    expect(out.success).toBe(true);
    expect(mocks.scrapeURLWithEngine).toHaveBeenCalled();
  });
});
