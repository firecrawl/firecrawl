import { describe, expect, it } from "vitest";
import { CrawlDenialError } from "../../../lib/error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../../lib/error-serde";
import { DenialReason, WebCrawler } from "../crawler";

const BASE = "https://example.com";
const BLOCKED = BASE + "/blocked/page";
const EXCLUDED = BASE + "/excluded/page";

function makeCrawler(ignoreRobotsTxt = false) {
  const crawler = new WebCrawler({
    jobId: "robots-denial-test",
    initialUrl: BASE + "/",
    excludes: ["^/excluded"],
    ignoreRobotsTxt,
  });
  crawler.importRobotsTxt("User-agent: *\nDisallow: /blocked\nAllow: /\n");
  return crawler;
}

describe("robots.txt denials", () => {
  it("lists only the robots.txt denials in filterLinks", async () => {
    const { links, denialReasons, robotsBlocked } =
      await makeCrawler().filterLinks(
        [BASE + "/ok", BLOCKED, EXCLUDED],
        10,
        10,
      );

    expect(links).toEqual([BASE + "/ok"]);
    expect(robotsBlocked).toEqual([BLOCKED]);
    expect(denialReasons.get(BLOCKED)).toBe(DenialReason.ROBOTS_TXT);
    expect(denialReasons.get(EXCLUDED)).toBeDefined();
  });

  it("lists no robots.txt denials when robots.txt is ignored", async () => {
    const { links, robotsBlocked } = await makeCrawler(true).filterLinks(
      [BASE + "/ok", BLOCKED],
      10,
      10,
    );

    expect(links).toEqual([BASE + "/ok", BLOCKED]);
    expect(robotsBlocked).toEqual([]);
  });

  it("checks a single URL against robots.txt unless robots.txt is ignored", () => {
    expect(makeCrawler().isRobotsAllowed(BASE + "/ok")).toBe(true);
    expect(makeCrawler().isRobotsAllowed(BLOCKED)).toBe(false);
    expect(makeCrawler(true).isRobotsAllowed(BLOCKED)).toBe(true);
  });

  it("keeps robots.txt-blocked links during extraction so filterLinks can report them", async () => {
    const html = `<a href="/ok">ok</a><a href="/blocked/page">blocked</a>`;
    const extracted = await makeCrawler().extractLinksFromContent(
      html,
      BASE + "/",
    );

    expect(extracted).toContain(BLOCKED);
  });

  it("keeps the robots.txt-blocked URL on CrawlDenialError through serialization", () => {
    const robots = deserializeTransportableError(
      serializeTransportableError(
        new CrawlDenialError("blocked", { robotsBlockedUrl: BLOCKED }),
      ),
    );
    const other = deserializeTransportableError(
      serializeTransportableError(new CrawlDenialError("excluded")),
    );

    expect(robots).toBeInstanceOf(CrawlDenialError);
    expect((robots as CrawlDenialError).robotsBlockedUrl).toBe(BLOCKED);
    expect((robots as CrawlDenialError).reason).toBe("blocked");
    expect((other as CrawlDenialError).robotsBlockedUrl).toBeNull();
  });
});
