import { createRobotsChecker, fetchRobotsTxt } from "../../../lib/robots-txt";
import { scrapeTimeout } from "./lib";

describe("Robots.txt tests", () => {
  const robotsUrl = "https://www.google.com/robots.txt";
  const siteUrl = "https://www.google.com/";
  let robotsTxt: string;
  let checker: ReturnType<typeof createRobotsChecker>;

  beforeAll(async () => {
    robotsTxt = await fetchRobotsTxt(robotsUrl);
    checker = createRobotsChecker(siteUrl, robotsTxt);
  }, scrapeTimeout);

  it(
    "contains expected directives",
    () => {
      expect(robotsTxt).toContain("User-agent");
      expect(robotsTxt).toContain("Disallow");
    },
    scrapeTimeout,
  );

  it("allows and disallows URLs as per rules", () => {
    expect(
      checker.robots.isAllowed(
        "https://www.google.com/search?q=test",
        "FireCrawlAgent",
      ),
    ).toBe(false);

    expect(
      checker.robots.isAllowed(
        "https://www.google.com/search/about",
        "FireCrawlAgent",
      ),
    ).toBe(true);

    expect(
      checker.robots.isAllowed(
        "https://www.google.com/groups",
        "FireCrawlAgent",
      ),
    ).toBe(false);

    expect(
      checker.robots.isAllowed(
        "https://www.google.com/preferences",
        "FireCrawlAgent",
      ),
    ).toBe(true);
  });

  it("includes Google's sitemap URLs", () => {
    const sitemaps = checker.robots.getSitemaps();

    expect(Array.isArray(sitemaps)).toBe(true);
    expect(sitemaps.length).toBeGreaterThan(0);

    expect(sitemaps).toContain("https://www.google.com/sitemap.xml");
  });
});
