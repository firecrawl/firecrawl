import { randomUUID } from "node:crypto";
import { scrapeOptions } from "../controllers/v2/types";
import {
  finishCrawlKickoff,
  isCrawlKickoffFinished,
  type StoredCrawl,
} from "../lib/crawl-redis";
import * as sitemap from "../scraper/crawler/sitemap";
import { redisEvictConnection as redis } from "../services/redis";
import type { NuQJob } from "../services/worker/nuq";
import { processJobInternal } from "../services/worker/scrape-worker";
import type { ScrapeJobKickoffSitemap } from "../types";

describe("sitemap kickoff bookkeeping", () => {
  let crawlKey: string;
  let job: NuQJob<ScrapeJobKickoffSitemap>;

  beforeEach(async () => {
    const crawlId = randomUUID();
    crawlKey = `crawl:${crawlId}`;
    job = {
      id: randomUUID(),
      createdAt: new Date(),
      priority: 0,
      status: "active",
      data: {
        mode: "kickoff_sitemap",
        team_id: `preview-${randomUUID()}`,
        crawl_id: crawlId,
        sitemapUrl: "https://example.com/sitemap.xml",
        origin: "api",
        v1: false,
        apiKeyId: null,
        zeroDataRetention: false,
        skipNuq: true,
      },
    };
    await finishCrawlKickoff(crawlId);
    await redis.sadd(`${crawlKey}:sitemap_jobs`, job.id);
    expect(await isCrawlKickoffFinished(crawlId)).toBe(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await redis.del(
      crawlKey,
      `${crawlKey}:kickoff:finish`,
      `${crawlKey}:sitemap_jobs`,
      `${crawlKey}:sitemap_jobs_done`,
    );
  });

  it("records completion when a sitemap is processed", async () => {
    const crawl: StoredCrawl = {
      originUrl: "https://example.com",
      crawlerOptions: {},
      scrapeOptions: scrapeOptions.parse({}),
      internalOptions: { teamId: job.data.team_id, orgId: null },
      team_id: job.data.team_id,
      createdAt: Date.now(),
    };
    await redis.set(crawlKey, JSON.stringify(crawl));
    const scrapeSitemap = vi
      .spyOn(sitemap, "scrapeSitemap")
      .mockResolvedValue({ urls: [], sitemaps: [] });

    await expect(processJobInternal(job)).resolves.toBeNull();
    expect(scrapeSitemap).toHaveBeenCalledOnce();
    expect(await isCrawlKickoffFinished(job.data.crawl_id)).toBe(true);
  });

  it("records completion even when the Redis crawl lookup fails", async () => {
    await redis.sadd(crawlKey, "not a crawl record");

    await expect(processJobInternal(job)).rejects.toThrow("WRONGTYPE");
    expect(await redis.smembers(`${crawlKey}:sitemap_jobs_done`)).toEqual([
      job.id,
    ]);
    expect(await isCrawlKickoffFinished(job.data.crawl_id)).toBe(true);
  });
});
