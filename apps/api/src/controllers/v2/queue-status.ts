import type { DefaultRequestParams, RequestWithAuth } from "./types";
import type { Response } from "express";
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
import { currentLimits } from "../../lib/limits";
import { requestContext } from "../../lib/request-context";

type QueueStatusResponse = {
  success: boolean;
  jobsInQueue: number;
  activeJobsInQueue: number;
  waitingJobsInQueue: number;
  maxConcurrency: number | null;
  mostRecentSuccess: string | null;
};

const FDB_OPTIONAL_COUNT_TIMEOUT_MS = 500;

export async function queueStatusController(
  req: RequestWithAuth<DefaultRequestParams, undefined, QueueStatusResponse>,
  res: Response<QueueStatusResponse>,
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

  await cleanOldConcurrencyLimitEntries(req.auth.team_id);
  let activeJobsOfTeam = await getConcurrencyLimitActiveJobsCount(
    req.auth.team_id,
  );
  await cleanOldConcurrencyLimitedJobs(req.auth.team_id);
  let queuedJobsOfTeam = await getConcurrencyQueueJobsCount(req.auth.team_id);

  // during the FDB migration a team can have load on both ledgers
  if (await isFdbTeam(req.auth.team_id, ctx)) {
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
    } catch (error: unknown) {
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
  const maxConcurrency = await currentLimits().concurrency(ctx);

  return res.status(200).json({
    success: true,

    jobsInQueue: activeJobsOfTeam + queuedJobsOfTeam,
    activeJobsInQueue: activeJobsOfTeam,
    waitingJobsInQueue: queuedJobsOfTeam,
    maxConcurrency,
    mostRecentSuccess: mostRecentSuccess
      ? new Date(mostRecentSuccess).toISOString()
      : null,
  });
}
