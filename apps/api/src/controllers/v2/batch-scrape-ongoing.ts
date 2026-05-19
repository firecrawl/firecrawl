import { Response } from "express";
import { OngoingBatchScrapesResponse, RequestWithAuth } from "./types";
import { getCrawl, getCrawlJobs } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { crawlGroup } from "../../services/worker/nuq";
configDotenv();

export async function ongoingBatchScrapesController(
  req: RequestWithAuth<{}, undefined, OngoingBatchScrapesResponse>,
  res: Response<OngoingBatchScrapesResponse>,
) {
  const ids = (await crawlGroup.getOngoingByOwner(req.auth.team_id)).map(
    x => x.id,
  );

  const batchScrapes = (
    await Promise.all(ids.map(async id => ({ ...(await getCrawl(id)), id })))
  ).filter(sc => sc !== null && !sc.cancelled && sc.crawlerOptions === null);

  const withUrlCounts = await Promise.all(
    batchScrapes.map(async sc => ({
      id: sc.id,
      teamId: sc.team_id!,
      created_at: new Date(sc.createdAt || Date.now()).toISOString(),
      urlCount: (await getCrawlJobs(sc.id)).length,
    })),
  );

  res.status(200).json({
    success: true,
    batchScrapes: withUrlCounts,
  });
}
