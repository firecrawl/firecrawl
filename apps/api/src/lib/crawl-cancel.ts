import {
  getCrawl,
  getCrawlJobs,
  markCrawlCancelled,
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
  let marked = true;
  try {
    await markCrawlCancelled(crawlId);
  } catch (error) {
    marked = false;
    logger.error("Failed to mark crawl cancelled", { error, crawlId });
  }

  let cleaned = false;
  if (crawl?.queueBackend === "pg") {
    try {
      const jobIds = await getCrawlJobs(crawlId);
      await removeConcurrencyLimitedJobs(crawl.team_id, jobIds);
      cleaned = true;
    } catch (error) {
      logger.error("Failed to clean up cancelled crawl jobs", {
        error,
        crawlId,
      });
    }
  } else {
    try {
      cleaned = await crawlGroup.cancelGroup(crawlId);
    } catch (error) {
      logger.error("Failed to clean up cancelled crawl jobs", {
        error,
        crawlId,
      });
    }

    const teamId = crawl?.team_id ?? fallbackTeamId;
    if (!cleaned && crawl?.queueBackend !== "fdb" && teamId) {
      try {
        const jobIds = await getCrawlJobs(crawlId);
        await removeConcurrencyLimitedJobs(teamId, jobIds);
        cleaned = true;
      } catch (error) {
        logger.error("Failed to clean up cancelled crawl jobs", {
          error,
          crawlId,
        });
      }
    }
  }

  return marked && cleaned;
}
