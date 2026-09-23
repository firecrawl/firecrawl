import {
  getCrawl,
  getCrawlJobs,
  saveCrawl,
  type StoredCrawl,
} from "./crawl-redis";
import { removeConcurrencyLimitedJobs } from "./concurrency-limit";
import { logger } from "./logger";
import { crawlGroup } from "../services/worker/nuq-router";

export async function cancelCrawl(
  crawlId: string,
  existingCrawl?: StoredCrawl,
  fallbackTeamId?: string,
): Promise<boolean> {
  const crawl = existingCrawl ?? (await getCrawl(crawlId));
  if (!crawl) {
    if (await crawlGroup.cancelGroup(crawlId)) return true;
    if (!fallbackTeamId) return false;

    const jobIds = await getCrawlJobs(crawlId);
    await removeConcurrencyLimitedJobs(fallbackTeamId, jobIds);
    return true;
  }

  try {
    crawl.cancelled = true;
    await saveCrawl(crawlId, crawl);
  } catch (error) {
    logger.error("Failed to mark crawl cancelled", { error, crawlId });
  }

  if (crawl.queueBackend === "fdb") {
    await crawlGroup.cancelGroup(crawlId);
  } else {
    const jobIds = await getCrawlJobs(crawlId);
    await removeConcurrencyLimitedJobs(crawl.team_id, jobIds);
  }

  return true;
}
