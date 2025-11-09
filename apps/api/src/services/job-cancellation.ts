import { Logger } from "winston";
import { scrapeQueue } from "./worker/nuq";
import {
  removeConcurrencyLimitActiveJob,
  removeConcurrencyLimitedJob,
  removeCrawlConcurrencyLimitActiveJob,
} from "../lib/concurrency-limit";
import { redisEvictConnection } from "./redis";

const CANCELLED_JOB_KEY_PREFIX = "cancelled-scrape-job:";
const CANCELLED_JOB_TTL_SECONDS = 60 * 60; // 1 hour

type CancelScrapeJobOptions = {
  jobId: string;
  teamId?: string;
  crawlId?: string;
  reason: string;
  logger: Logger;
};

export async function cancelScrapeJob({
  jobId,
  teamId,
  crawlId,
  reason,
  logger,
}: CancelScrapeJobOptions) {
  const telemetry = {
    module: "scrape/cancellation",
    jobId,
    teamId,
    crawlId,
    reason,
  };

  logger.info("Cancelling scrape job", telemetry);

  await markScrapeJobCancelled(jobId, reason).catch(error => {
    logger.warn("Failed to mark job as cancelled", {
      ...telemetry,
      error,
    });
  });

  await scrapeQueue.removeJob(jobId, logger).catch(error => {
    logger.debug("Job removal from NuQ failed (may already be gone)", {
      ...telemetry,
      error,
      stage: "nuq_remove",
    });
  });

  if (teamId) {
    await Promise.all([
      removeConcurrencyLimitActiveJob(teamId, jobId).catch(error => {
        logger.debug("Failed to remove job from active concurrency set", {
          ...telemetry,
          error,
          stage: "concurrency_active_remove",
        });
      }),
      removeConcurrencyLimitedJob(teamId, jobId).catch(error => {
        logger.debug("Failed to remove job from concurrency queue", {
          ...telemetry,
          error,
          stage: "concurrency_queue_remove",
        });
      }),
    ]);
  }

  if (crawlId) {
    await removeCrawlConcurrencyLimitActiveJob(crawlId, jobId).catch(error => {
      logger.debug("Failed to remove job from crawl concurrency set", {
        ...telemetry,
        error,
        stage: "crawl_concurrency_remove",
      });
    });
  }

  logger.info("Scrape job cancellation completed", {
    ...telemetry,
    stage: "completed",
  });
}

export async function markScrapeJobCancelled(jobId: string, reason: string) {
  await redisEvictConnection.set(
    CANCELLED_JOB_KEY_PREFIX + jobId,
    reason,
    "EX",
    CANCELLED_JOB_TTL_SECONDS,
  );
}

export async function isScrapeJobCancelled(jobId: string) {
  return (
    (await redisEvictConnection.exists(CANCELLED_JOB_KEY_PREFIX + jobId)) === 1
  );
}

export async function getScrapeJobCancellationReason(jobId: string) {
  return await redisEvictConnection.get(CANCELLED_JOB_KEY_PREFIX + jobId);
}
