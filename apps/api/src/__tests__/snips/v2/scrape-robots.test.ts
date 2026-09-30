import { randomUUID } from "node:crypto";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { CrawlDenialError } from "../../../lib/error";
import * as robots from "../../../lib/robots-txt";
import { scrapeURL } from "../../../scraper/scrapeURL";
import * as engines from "../../../scraper/scrapeURL/engines";
import { ALLOW_TEST_SUITE_WEBSITE, itIf, TEST_SUITE_WEBSITE } from "../lib";
import { scrapeTimeout } from "./lib";

// Exercise the pipeline directly so team flags are covered in self-hosted
// configurations too. Only robots.txt retrieval is stubbed; parsing, tracing,
// and the fetch engine use their real implementations.
describe("Scrape robots policy", () => {
  beforeEach(() => {
    vi.spyOn(robots, "fetchRobotsTxt").mockResolvedValue({
      content: "User-agent: *\nDisallow: /\n",
      url: new URL("/robots.txt", TEST_SUITE_WEBSITE).href,
    });
    vi.spyOn(engines, "scrapeURLWithEngine");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runScrape = (checkRobotsOnScrape = true) =>
    scrapeURL(
      randomUUID(),
      TEST_SUITE_WEBSITE,
      scrapeOptions.parse({ formats: ["rawHtml"], maxAge: 0 }),
      {
        teamId: "scrape-robots-test",
        orgId: null,
        forceEngine: "fetch",
        teamFlags: { checkRobotsOnScrape },
      },
      new CostTracking(),
    );

  it(
    "returns a denial before invoking an engine for a disallowed URL",
    async () => {
      const result = await runScrape();

      expect(robots.fetchRobotsTxt).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected a robots denial");
      expect(result.error).toBeInstanceOf(CrawlDenialError);
      expect(result.error.message).toBe("URL blocked by robots.txt");
      expect(engines.scrapeURLWithEngine).not.toHaveBeenCalled();
    },
    scrapeTimeout,
  );

  // External proxies cannot reach the local test site. Keep the denial test
  // above unconditional because it must finish before any engine is invoked.
  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "scrapes an allowed URL",
    async () => {
      vi.mocked(robots.fetchRobotsTxt).mockResolvedValue({
        content: "User-agent: *\nAllow: /\n",
        url: new URL("/robots.txt", TEST_SUITE_WEBSITE).href,
      });

      const result = await runScrape();

      expect(robots.fetchRobotsTxt).toHaveBeenCalledOnce();
      expect(result.success).toBe(true);
      expect(engines.scrapeURLWithEngine).toHaveBeenCalled();
    },
    scrapeTimeout,
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "scrapes without checking robots when the team flag is disabled",
    async () => {
      const result = await runScrape(false);

      expect(result.success).toBe(true);
      expect(robots.fetchRobotsTxt).not.toHaveBeenCalled();
      expect(engines.scrapeURLWithEngine).toHaveBeenCalled();
    },
    scrapeTimeout,
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "allows scraping when robots.txt retrieval fails",
    async () => {
      vi.mocked(robots.fetchRobotsTxt).mockRejectedValue(
        new Error("Fetch failed"),
      );

      const result = await runScrape();

      expect(result.success).toBe(true);
      expect(engines.scrapeURLWithEngine).toHaveBeenCalled();
    },
    scrapeTimeout,
  );
});
