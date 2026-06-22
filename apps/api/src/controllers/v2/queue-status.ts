import { RateLimiterMode } from "../../types";
import { getACUCTeam } from "../auth";
import { RequestWithAuth } from "./types";
import { AuthCreditUsageChunkFromTeam } from "../v1/types";
import { Response } from "express";
import { redisEvictConnection } from "../../services/redis";
import { isFdbTeam } from "../../services/worker/nuq-router";
import {
  nuqFdbHealthCheck,
  scrapeQueueFdb,
  withFdbTimeout,
} from "../../services/worker/nuq-fdb";
import { logger } from "../../lib/logger";
import {
  cleanOldConcurrencyLimitedJobs,
  cleanOldConcurrencyLimitEntries,
  getConcurrencyLimitActiveJobsCount,
  getConcurrencyQueueJobsCount,
} from "../../lib/concurrency-limit";

type QueueStatusResponse = {
  success: boolean;
  jobsInQueue: number;
  activeJobsInQueue: number;
  waitingJobsInQueue: number;
  maxConcurrency: number;
  mostRecentSuccess: string | null;
};

const FDB_OPTIONAL_COUNT_TIMEOUT_MS = 500;

export async function queueStatusController(
  req: RequestWithAuth<{}, undefined, QueueStatusResponse>,
  res: Response<QueueStatusResponse>,
) {
  let otherACUC: AuthCreditUsageChunkFromTeam | null = null;
  if (!req.acuc?.is_extract) {
    otherACUC = await getACUCTeam(
      req.auth.team_id,
      false,
      true,
      RateLimiterMode.Extract,
    );
  } else {
    otherACUC = await getACUCTeam(
      req.auth.team_id,
      false,
      true,
      RateLimiterMode.Crawl,
    );
  }

  await cleanOldConcurrencyLimitEntries(req.auth.team_id);
  let activeJobsOfTeam = await getConcurrencyLimitActiveJobsCount(
    req.auth.team_id,
  );
  await cleanOldConcurrencyLimitedJobs(req.auth.team_id);
  let queuedJobsOfTeam = await getConcurrencyQueueJobsCount(req.auth.team_id);

  // during the FDB migration a team can have load on both ledgers
  if (await isFdbTeam(req.auth.team_id)) {
    try {
      if (await nuqFdbHealthCheck(FDB_OPTIONAL_COUNT_TIMEOUT_MS)) {
        const [fdbActive, fdbPending] = await Promise.all([
          withFdbTimeout(
            scrapeQueueFdb.getTeamActiveCount(req.auth.team_id),
            FDB_OPTIONAL_COUNT_TIMEOUT_MS,
          ),
          withFdbTimeout(
            scrapeQueueFdb.getTeamPendingCount(req.auth.team_id),
            FDB_OPTIONAL_COUNT_TIMEOUT_MS,
          ),
        ]);
        activeJobsOfTeam += fdbActive;
        queuedJobsOfTeam += fdbPending;
      }
    } catch (error) {
      logger.warn("Failed to read FDB queue counts, falling back to Redis", {
        module: "queue-status",
        version: "v2",
        error,
      });
    }
  }

  // most-recent-success is written by the scrape worker via redisEvictConnection
  // (REDIS_EVICT_URL), which is a different instance from getRedisConnection()
  // (REDIS_URL). Read it from the same connection it is written to.
  const mostRecentSuccess = await redisEvictConnection.get(
    "most-recent-success:" + req.auth.team_id,
  );

  return res.status(200).json({
    success: true,

    jobsInQueue: activeJobsOfTeam + queuedJobsOfTeam,
    activeJobsInQueue: activeJobsOfTeam,
    waitingJobsInQueue: queuedJobsOfTeam,
    maxConcurrency: Math.max(
      req.acuc?.concurrency ?? 1,
      otherACUC?.concurrency ?? 1,
    ),

    mostRecentSuccess: mostRecentSuccess
      ? new Date(mostRecentSuccess).toISOString()
      : null,
  });
}
