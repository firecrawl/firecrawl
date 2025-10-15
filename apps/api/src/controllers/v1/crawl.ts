import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  CrawlRequest,
  crawlRequestSchema,
  CrawlResponse,
  RequestWithAuth,
  toLegacyCrawlerOptions,
} from "./types";
import {
  crawlToCrawler,
  saveCrawl,
  StoredCrawl,
  markCrawlActive,
} from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../../services/queue-jobs";
import { logger as _logger } from "../../lib/logger";
import { fromV1ScrapeOptions } from "../v2/types";
import { checkPermissions } from "../../lib/permissions";

export async function crawlController(
  req: RequestWithAuth<{}, CrawlResponse, CrawlRequest>,
  res: Response<CrawlResponse>,
) {
  const preNormalizedBody = req.body;
  req.body = crawlRequestSchema.parse(req.body);

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  const zeroDataRetention =
    req.acuc?.flags?.forceZDR || req.body.zeroDataRetention;

  const id = uuidv4();
  const logger = _logger.child({
    crawlId: id,
    module: "api/v1",
    method: "crawlController",
    teamId: req.auth.team_id,
    zeroDataRetention,
  });

  logger.debug("Crawl " + id + " starting", {
    request: req.body,
    originalRequest: preNormalizedBody,
    account: req.account,
  });

  let { remainingCredits } = req.account!;
  const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
  if (!useDbAuthentication) {
    remainingCredits = Infinity;
  }

  const crawlerOptions = {
    ...req.body,
    url: undefined,
    scrapeOptions: undefined,
  };
  const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
    req.body.scrapeOptions,
    req.body.scrapeOptions.timeout,
    req.auth.team_id,
  );

  // TODO: @rafa, is this right? copied from v0
  if (Array.isArray(crawlerOptions.includePaths)) {
    for (const x of crawlerOptions.includePaths) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  if (Array.isArray(crawlerOptions.excludePaths)) {
    for (const x of crawlerOptions.excludePaths) {
      try {
        new RegExp(x);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }
  }

  const originalLimit = crawlerOptions.limit;
  crawlerOptions.limit = Math.min(remainingCredits, crawlerOptions.limit);
  logger.debug("Determined limit: " + crawlerOptions.limit, {
    remainingCredits,
    bodyLimit: originalLimit,
    originalBodyLimit: preNormalizedBody.limit,
  });

  const sc: StoredCrawl = {
    originUrl: req.body.url,
    crawlerOptions: toLegacyCrawlerOptions(crawlerOptions),
    scrapeOptions,
    internalOptions: {
      ...internalOptions,
      disableSmartWaitCache: true,
      teamId: req.auth.team_id,
      saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
        ? true
        : false,
      zeroDataRetention,
    }, // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    maxConcurrency:
      req.body.maxConcurrency !== undefined
        ? req.acuc?.concurrency !== undefined
          ? Math.min(req.body.maxConcurrency, req.acuc.concurrency)
          : req.body.maxConcurrency
        : undefined,
    zeroDataRetention,
  };

  const crawler = crawlToCrawler(id, sc, req.acuc?.flags ?? null);

  try {
    sc.robots = await crawler.getRobotsTxt(scrapeOptions.skipTlsVerification);
    // const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
    // if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
    //   sc.crawlerOptions.delay = robotsCrawlDelay;
    // }
  } catch (e) {
    logger.debug("Failed to get robots.txt (this is probably fine!)", {
      error: e,
    });
  }

  await saveCrawl(id, sc);

  await markCrawlActive(id);

  await _addScrapeJobToBullMQ(
    {
      mode: "kickoff" as const,
      url: req.body.url,
      team_id: req.auth.team_id,
      crawlerOptions,
      scrapeOptions: sc.scrapeOptions,
      internalOptions: sc.internalOptions,
      origin: req.body.origin,
      integration: req.body.integration,
      crawl_id: id,
      webhook: req.body.webhook,
      v1: true,
      zeroDataRetention: zeroDataRetention || false,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    crypto.randomUUID(),
  );

  const protocol = process.env.ENV === "local" ? req.protocol : "https";

  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.get("host")}/v1/crawl/${id}`,
  });
}
