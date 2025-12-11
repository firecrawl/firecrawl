import { RateLimiterMode } from "../../types";
import { getACUCTeam } from "../auth";
import { AuthCreditUsageChunkFromTeam, RequestWithAuth } from "./types";
import { Response } from "express";
import { getRedisConnection } from "../../services/queue-service";
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
  const activeJobsOfTeam = await getConcurrencyLimitActiveJobsCount(
    req.auth.team_id,
  );
  await cleanOldConcurrencyLimitedJobs(req.auth.team_id);
  const queuedJobsOfTeam = await getConcurrencyQueueJobsCount(req.auth.team_id);

  const mostRecentSuccess = await getRedisConnection().get(
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
