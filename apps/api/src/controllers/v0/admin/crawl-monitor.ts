import { Response } from "express";
import { logger as _logger } from "../../../lib/logger";
import {
  crawlerOptions,
  RequestWithAuth,
  scrapeOptions,
  toV0CrawlerOptions,
} from "../../v2/types";
import { v7 as uuidv7 } from "uuid";
import { logRequest } from "../../../services/logging/log_job";
import {
  crawlToCrawler,
  markCrawlActive,
  saveCrawl,
  StoredCrawl,
} from "../../../lib/crawl-redis";
import { config } from "../../../config";
import { crawlGroup } from "../../../services/worker/nuq";
import { _addScrapeJobToBullMQ } from "../../../services/queue-jobs";

type ResponseType = {
  ok: boolean;
  crawlId: string;
};

export async function crawlMonitorController(
  req: RequestWithAuth<{}, undefined, ResponseType>,
  res: Response<ResponseType>,
) {
  const id = uuidv7();

  const logger = _logger.child({
    module: "crawl-monitor",
    method: "crawlMonitorController",
    crawlId: id,
  });

  logger.debug("Crawl monitor " + id + " starting", {
    account: req.account,
  });

  await logRequest({
    id,
    kind: "crawl",
    api_version: "v2",
    team_id: req.auth.team_id,
    origin: "api",
    integration: null,
    target_hint: "https://firecrawl.dev",
    zeroDataRetention: false,
    api_key_id: req.acuc?.api_key_id ?? null,
  });

  const sc: StoredCrawl = {
    originUrl: "https://firecrawl.dev",
    crawlerOptions: toV0CrawlerOptions(crawlerOptions.parse({ limit: 2 })),
    scrapeOptions: scrapeOptions.parse({}),
    internalOptions: {
      disableSmartWaitCache: true,
      teamId: req.auth.team_id,
      saveScrapeResultToGCS: config.GCS_FIRE_ENGINE_BUCKET_NAME ? true : false,
      zeroDataRetention: false,
    },
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    maxConcurrency: undefined,
    zeroDataRetention: false,
  };

  const crawler = crawlToCrawler(id, sc, req.acuc?.flags ?? null);

  try {
    sc.robots = await crawler.getRobotsTxt(false);
  } catch (e) {
    logger.debug("Failed to get robots.txt (this is probably fine!)", {
      error: e,
    });
  }

  await crawlGroup.addGroup(
    id,
    sc.team_id,
    (req.acuc?.flags?.crawlTtlHours ?? 24) * 60 * 60 * 1000,
  );

  await saveCrawl(id, sc);

  await markCrawlActive(id);

  await _addScrapeJobToBullMQ(
    {
      url: "https://firecrawl.dev",
      mode: "kickoff" as const,
      team_id: req.auth.team_id,
      crawlerOptions: crawlerOptions.parse({ limit: 2 }),
      scrapeOptions: sc.scrapeOptions,
      internalOptions: sc.internalOptions,
      origin: "api",
      integration: null,
      crawl_id: id,
      webhook: undefined,
      v1: true,
      zeroDataRetention: false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    uuidv7(),
  );

  const startTime = Date.now();

  while (Date.now() - startTime < 60000) {
    const group = await crawlGroup.getGroup(id);
    if (group?.status === "completed") {
      logger.debug("Crawl completed");
      return res.status(200).json({
        ok: true,
        crawlId: id,
      });
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  logger.warn("Crawl timed out");
  return res.status(500).json({
    ok: false,
    crawlId: id,
  });
}
