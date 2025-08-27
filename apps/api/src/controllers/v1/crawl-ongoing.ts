import { Response } from "express";
import {
  OngoingCrawlsResponse,
  RequestWithAuth,
  toNewCrawlerOptions,
} from "./types";
import {
  getCrawl,
  getCrawlsByTeamId,
} from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
configDotenv();

export async function ongoingCrawlsController(
  req: RequestWithAuth<{}, undefined, OngoingCrawlsResponse>,
  res: Response<OngoingCrawlsResponse>,
) {
  const ids = await getCrawlsByTeamId(req.auth.team_id);

  const crawls = (await Promise.all(ids.map(async id => ({ ...(await getCrawl(id)), id })))).filter((crawl) => crawl !== null && !crawl.cancelled && crawl.crawlerOptions);

  res.status(200).json({
    success: true,
    crawls: crawls.map(x => ({
      id: x.id,
      teamId: x.team_id!,
      url: x.originUrl!,
      created_at: new Date(x.createdAt || Date.now()).toISOString(),
      options: {
        ...toNewCrawlerOptions(x.crawlerOptions),
        scrapeOptions: x.scrapeOptions,
      },
    })),
  });
}
