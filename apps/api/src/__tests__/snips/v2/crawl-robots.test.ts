import { describe, expect } from "vitest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { crawl, crawlErrors, Identity, idmux, scrapeTimeout } from "./lib";

// The test site's robots.txt disallows /robots-test/blocked/. The
// /robots-test/ page is allowed and links to the blocked page.
const ROBOTS_TEST_URL = TEST_SUITE_WEBSITE + "/robots-test/";
const ROBOTS_BLOCKED_URL = TEST_SUITE_WEBSITE + "/robots-test/blocked/";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "crawl-robots",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

const isBlockedUrl = (url: string) => url.includes("/robots-test/blocked");

describe("Crawl robots.txt reporting", () => {
  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "reports a start URL that robots.txt disallows",
    async () => {
      const results = await crawl(
        { url: ROBOTS_BLOCKED_URL, limit: 5 },
        identity,
        false,
      );

      expect(results.status).not.toBe("scraping");
      expect(results.warning ?? "").toContain("robots.txt");
      expect(results.warning ?? "").toContain("robotsBlocked");
      expect(
        (await crawlErrors(results.id, identity)).robotsBlocked.some(
          isBlockedUrl,
        ),
      ).toBe(true);
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "reports a discovered link that robots.txt disallows",
    async () => {
      const results = await crawl({ url: ROBOTS_TEST_URL, limit: 5 }, identity);

      expect(results.data.some(d => isBlockedUrl(d.metadata?.url ?? ""))).toBe(
        false,
      );
      expect(results.warning).toContain("robots.txt");
      expect(results.warning).toContain("robotsBlocked");
      expect(
        (await crawlErrors(results.id, identity)).robotsBlocked.some(
          isBlockedUrl,
        ),
      ).toBe(true);
    },
    5 * scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "does not warn when robots.txt allows every crawled page",
    async () => {
      const results = await crawl(
        { url: TEST_SUITE_WEBSITE, limit: 3 },
        identity,
      );

      expect(results.warning ?? "").not.toContain("robots.txt");
      expect((await crawlErrors(results.id, identity)).robotsBlocked).toEqual(
        [],
      );
    },
    5 * scrapeTimeout,
  );
});
