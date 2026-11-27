import { randomUUID } from "node:crypto";
import type { MockInstance } from "vitest";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { CrawlDenialError } from "../../../lib/error";
import type { fetchRobotsTxt } from "../../../lib/robots-txt";
import { scrapeURL } from "../../../scraper/scrapeURL";
import {
  coreEngineFeatures,
  coreEngines,
} from "../../../scraper/scrapeURL/engines";
import type { scrapeURLWithEngine } from "../../../scraper/scrapeURL/engines";
import { createService, replaceService } from "../../../service/service";
import { ALLOW_TEST_SUITE_WEBSITE, itIf, TEST_SUITE_WEBSITE } from "../lib";
import { scrapeTimeout } from "./lib";

const runScrape = (checkRobotsOnScrape = true) =>
  scrapeURL(
    randomUUID(),
    TEST_SUITE_WEBSITE,
    scrapeOptions.parse({ formats: ["rawHtml"] }),
    {
      teamId: "scrape-robots-test",
      orgId: null,
      forceEngine: "fetch",
      teamFlags: { checkRobotsOnScrape },
    },
    new CostTracking(),
  );

// Exercise the pipeline directly so team flags are covered in self-hosted
// configurations too. Only robots.txt retrieval is stubbed; parsing, tracing,
// and the fetch engine use their real implementations.
describe("Scrape robots policy", () => {
  let fetchRobotsTxtSpy: MockInstance<typeof fetchRobotsTxt>;
  let scrapeURLWithEngineSpy: MockInstance<typeof scrapeURLWithEngine>;

  beforeAll(() => {
    replaceService(
      createService(
        { modules: {} },
        {
          core: {
            name: "core",
            engines: coreEngines,
            engineFeatures: coreEngineFeatures,
          },
          logger: { error: vi.fn() },
        },
      ),
    );
  });

  afterAll(() => {
    replaceService(undefined);
  });

  beforeEach(async () => {
    const robots = await import("../../../lib/robots-txt.js");
    const engines = await import("../../../scraper/scrapeURL/engines/index.js");
    fetchRobotsTxtSpy = vi.spyOn(robots, "fetchRobotsTxt").mockResolvedValue({
      content: "User-agent: *\nDisallow: /\n",
      url: new URL("/robots.txt", TEST_SUITE_WEBSITE).href,
    });
    scrapeURLWithEngineSpy = vi.spyOn(engines, "scrapeURLWithEngine");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns a denial before invoking an engine for a disallowed URL",
    async () => {
      const result = await runScrape();

      expect(fetchRobotsTxtSpy).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected a robots denial");
      }
      expect(result.error).toBeInstanceOf(CrawlDenialError);
      if (!(result.error instanceof CrawlDenialError)) {
        throw new Error("Expected CrawlDenialError");
      }
      expect(result.error.message).toBe("URL blocked by robots.txt");
      expect(result.error.robotsBlockedUrl).toBe(TEST_SUITE_WEBSITE);
      expect(scrapeURLWithEngineSpy).not.toHaveBeenCalled();
    },
    scrapeTimeout,
  );

  // External proxies cannot reach the local test site. Keep the denial test
  // above unconditional because it must finish before any engine is invoked.
  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "scrapes an allowed URL",
    async () => {
      fetchRobotsTxtSpy.mockResolvedValue({
        content: "User-agent: *\nAllow: /\n",
        url: new URL("/robots.txt", TEST_SUITE_WEBSITE).href,
      });

      const result = await runScrape();

      expect(fetchRobotsTxtSpy).toHaveBeenCalledOnce();
      expect(result.success).toBe(true);
      expect(scrapeURLWithEngineSpy).toHaveBeenCalled();
    },
    scrapeTimeout,
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "scrapes without checking robots when the team flag is disabled",
    async () => {
      const result = await runScrape(false);

      expect(result.success).toBe(true);
      expect(fetchRobotsTxtSpy).not.toHaveBeenCalled();
      expect(scrapeURLWithEngineSpy).toHaveBeenCalled();
    },
    scrapeTimeout,
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE)(
    "allows scraping when robots.txt retrieval fails",
    async () => {
      fetchRobotsTxtSpy.mockRejectedValue(new Error("Fetch failed"));

      const result = await runScrape();

      expect(result.success).toBe(true);
      expect(scrapeURLWithEngineSpy).toHaveBeenCalled();
    },
    scrapeTimeout,
  );
});
