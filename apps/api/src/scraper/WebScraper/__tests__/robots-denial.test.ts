import { describe, expect, it } from "vitest";
import { CrawlDenialError } from "../../../lib/error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../../lib/error-serde";
import { isRobotsDenialReason, WebCrawler } from "../crawler";

const BASE = "https://example.com";
const BLOCKED = BASE + "/blocked/page";
const EXCLUDED = BASE + "/excluded/page";

function makeCrawler() {
  const crawler = new WebCrawler({
    jobId: "robots-denial-test",
    initialUrl: BASE + "/",
    excludes: ["^/excluded"],
  });
  crawler.importRobotsTxt("User-agent: *\nDisallow: /blocked\nAllow: /\n");
  return crawler;
}

describe("robots.txt denials", () => {
  it("flags only the robots.txt denial in filterLinks", async () => {
    const { links, denialReasons } = await makeCrawler().filterLinks(
      [BASE + "/ok", BLOCKED, EXCLUDED],
      10,
      10,
    );

    expect(links).toEqual([BASE + "/ok"]);
    expect(isRobotsDenialReason(denialReasons.get(BLOCKED))).toBe(true);
    expect(denialReasons.get(EXCLUDED)).toBeDefined();
    expect(isRobotsDenialReason(denialReasons.get(EXCLUDED))).toBe(false);
    expect(isRobotsDenialReason(undefined)).toBe(false);
  });

  it("keeps robots.txt-blocked links during extraction so filterLinks can report them", async () => {
    const html = `<a href="/ok">ok</a><a href="/blocked/page">blocked</a>`;
    const extracted = await makeCrawler().extractLinksFromContent(
      html,
      BASE + "/",
    );

    expect(extracted).toContain(BLOCKED);
  });

  it("keeps the robots marker on CrawlDenialError through serialization", () => {
    const robots = deserializeTransportableError(
      serializeTransportableError(
        new CrawlDenialError("blocked", { robots: true }),
      ),
    );
    const other = deserializeTransportableError(
      serializeTransportableError(new CrawlDenialError("excluded")),
    );

    expect(robots).toBeInstanceOf(CrawlDenialError);
    expect((robots as CrawlDenialError).robots).toBe(true);
    expect((robots as CrawlDenialError).reason).toBe("blocked");
    expect((other as CrawlDenialError).robots).toBe(false);
  });
});
