import { Response } from "express";
import {
  OngoingCrawlsResponse,
  RequestWithAuth,
  toV2CrawlerOptions,
} from "./types";
import { getCrawl } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { crawlGroup } from "../../services/worker/nuq-router";
import { requestContext } from "../../lib/request-context";
configDotenv();

export async function ongoingCrawlsController(
  req: RequestWithAuth<{}, undefined, OngoingCrawlsResponse>,
  res: Response<OngoingCrawlsResponse>,
) {
  const ctx = requestContext({
    teamId: req.auth.team_id,
    zeroDataRetention: false,
    flags: req.acuc?.flags ?? null,
    orgId: req.acuc?.org_id ?? null,
    apiKeyId: req.acuc?.api_key_id ?? null,
    concurrencyLimit: req.acuc?.concurrency_limit,
    rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
  });

  const ids = (
    await crawlGroup.getOngoingByOwner(req.auth.team_id, undefined, ctx)
  ).map(x => x.id);

  const crawls = (
    await Promise.all(ids.map(async id => ({ ...(await getCrawl(id)), id })))
  ).filter(crawl => crawl !== null && !crawl.cancelled && crawl.crawlerOptions);

  res.status(200).json({
    success: true,
    crawls: crawls.map(x => ({
      id: x.id,
      teamId: x.team_id!,
      url: x.originUrl!,
      created_at: new Date(x.createdAt || Date.now()).toISOString(),
      options: {
        ...toV2CrawlerOptions(x.crawlerOptions),
        scrapeOptions: x.scrapeOptions,
      },
    })),
  });
}
