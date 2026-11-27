import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../scrapeURL", () => ({
  scrapeURL: vi.fn(async () => ({ success: false, error: "unreachable" })),
}));

import { scrapeURL } from "../../scrapeURL";
import { crawlToCrawler } from "../../../lib/crawl-redis";
import type { StoredCrawl } from "../../../lib/crawl-redis";
import { scrapeOptions } from "../../../controllers/v2/types";
import { getLinksFromSitemap } from "../sitemap";
import { scrapeSitemap } from "../../crawler/sitemap";
import { logger } from "../../../lib/logger";

const storedCrawl = (teamFlags?: { usOnly?: boolean }): StoredCrawl => ({
  originUrl: "https://example.com/",
  crawlerOptions: {},
  scrapeOptions: scrapeOptions.parse({}),
  internalOptions: { teamId: "team-a", orgId: null, teamFlags },
  team_id: "team-a",
  createdAt: 0,
});

const internalOptionsSent = () =>
  vi
    .mocked(scrapeURL)
    .mock.calls.map(([, , , internalOptions]) => internalOptions);

beforeEach(() => {
  vi.mocked(scrapeURL).mockClear();
});

describe("crawl discovery for US-only teams", () => {
  it("marks the crawler US-only from the stored crawl or the team's live flags", () => {
    expect(
      crawlToCrawler("crawl-1", storedCrawl({ usOnly: true }), null).usOnly,
    ).toBe(true);
    expect(
      crawlToCrawler("crawl-1", storedCrawl(), { usOnly: true }).usOnly,
    ).toBe(true);
    expect(crawlToCrawler("crawl-1", storedCrawl(), null).usOnly).toBe(false);
  });

  it("fetches robots.txt as US-only", async () => {
    await crawlToCrawler(
      "crawl-1",
      storedCrawl({ usOnly: true }),
      null,
    ).getRobotsTxt();
    expect(internalOptionsSent()).toEqual([
      expect.objectContaining({
        teamId: "robots-txt",
        ctx: expect.objectContaining({ teamId: "robots-txt", usOnly: true }),
      }),
    ]);
  });

  it("fetches other teams' robots.txt without usOnly", async () => {
    await crawlToCrawler("crawl-1", storedCrawl(), null).getRobotsTxt();
    expect(internalOptionsSent()).toHaveLength(1);
    expect(internalOptionsSent()[0]?.ctx?.usOnly).toBeUndefined();
  });

  it("fetches nested sitemaps as US-only", async () => {
    vi.mocked(scrapeURL).mockResolvedValueOnce({
      success: true,
      document: {
        rawHtml:
          '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap></sitemapindex>',
        metadata: { statusCode: 200, proxyUsed: "basic" },
      },
    });
    await getLinksFromSitemap(
      {
        sitemapUrl: "https://example.com/sitemap.xml",
        urlsHandler: () => {},
        mode: "fire-engine",
        zeroDataRetention: false,
        usOnly: true,
      },
      logger,
      "crawl-1",
      new Set(),
    );
    expect(vi.mocked(scrapeURL).mock.calls.map(([, url]) => url)).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap-posts.xml",
    ]);
    expect(internalOptionsSent()).toEqual([
      expect.objectContaining({
        ctx: expect.objectContaining({ teamId: "sitemap", usOnly: true }),
      }),
      expect.objectContaining({
        ctx: expect.objectContaining({ teamId: "sitemap", usOnly: true }),
      }),
    ]);
  });

  it("fetches sitemaps as US-only", async () => {
    await getLinksFromSitemap(
      {
        sitemapUrl: "https://example.com/sitemap.xml",
        urlsHandler: () => {},
        mode: "fire-engine",
        zeroDataRetention: false,
        usOnly: true,
      },
      logger,
      "crawl-1",
      new Set(),
    );
    await expect(
      scrapeSitemap({
        url: "https://example.com/sitemap-2.xml",
        maxAge: 0,
        zeroDataRetention: false,
        usOnly: true,
        location: undefined,
        crawlId: "crawl-1",
      }),
    ).rejects.toThrow();
    expect(internalOptionsSent()).toEqual([
      expect.objectContaining({
        teamId: "sitemap",
        ctx: expect.objectContaining({ teamId: "sitemap", usOnly: true }),
      }),
      expect.objectContaining({
        teamId: "sitemap",
        ctx: expect.objectContaining({ teamId: "sitemap", usOnly: true }),
      }),
    ]);
  });

  it("prefers live teamFlags over stored context flags and enforces Safe Mode robots default", async () => {
    const sc: StoredCrawl = {
      originUrl: "https://example.com/",
      crawlerOptions: { ignoreRobotsTxt: true },
      scrapeOptions: scrapeOptions.parse({}),
      ctx: {
        teamId: "team-a",
        zeroDataRetention: false,
        flags: { ignoreRobots: "forced" },
      },
      internalOptions: { teamId: "team-a", orgId: null },
      team_id: "team-a",
      createdAt: 0,
    };

    const strictCrawler = crawlToCrawler("crawl-safe-default", sc, {
      safeMode: true,
      ignoreRobots: "forced",
      scrapeZDR: "forced",
    });
    strictCrawler.importRobotsTxt("User-agent: *\nDisallow: /\n");
    expect(strictCrawler.isRobotsAllowed("https://example.com/blocked")).toBe(
      false,
    );
    await strictCrawler.getRobotsTxt();
    expect(internalOptionsSent()).toEqual([
      expect.objectContaining({
        zeroDataRetention: true,
      }),
    ]);

    const optOutCrawler = crawlToCrawler("crawl-safe-opt-out", sc, {
      safeMode: true,
      safeModeConfig: { enforceRobots: false },
      ignoreRobots: "forced",
    });
    optOutCrawler.importRobotsTxt("User-agent: *\nDisallow: /\n");
    expect(optOutCrawler.isRobotsAllowed("https://example.com/blocked")).toBe(
      true,
    );
  });
});
