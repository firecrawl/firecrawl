import type { Request, Response } from "express";
import { getRedisConnection } from "../../../services/queue-service";
import { nuqGetLocalMetrics, scrapeQueue } from "../../../services/worker/nuq";
import { teamConcurrencySemaphore } from "../../../services/worker/team-semaphore";

export async function metricsController(_: Request, res: Response) {
  let cursor: string = "0";
  let totalJobCount = 0;
  let teamCount = 0;
  do {
    const res = await getRedisConnection().sscan(
      "concurrency-limit-queues",
      cursor,
    );
    cursor = res[0];

    const keys = res[1];

    for (const key of keys) {
      const jobCount = await getRedisConnection().zcard(key);

      if (jobCount === 0) {
        await getRedisConnection().srem("concurrency-limit-queues", key);
      } else {
        totalJobCount += jobCount;
        teamCount++;
      }
    }
  } while (cursor !== "0");

  const semaphoreMetrics = await teamConcurrencySemaphore.getMetrics();

  res.contentType("text/plain").send(`\
# HELP concurrency_limit_queue_job_count_total The total number of jobs across all concurrency limit queues
# TYPE concurrency_limit_queue_job_count_total gauge
concurrency_limit_queue_job_count_total ${totalJobCount}

# HELP concurrency_limit_queue_team_count The number of teams with jobs in the concurrency limit queue
# TYPE concurrency_limit_queue_team_count gauge
concurrency_limit_queue_team_count ${teamCount}

# HELP billed_teams_count The number of teams that have been billed but not yet tallied
# TYPE billed_teams_count gauge
billed_teams_count ${await getRedisConnection().scard("billed_teams")}

${nuqGetLocalMetrics()}
${semaphoreMetrics}`);
}

export async function nuqMetricsController(_: Request, res: Response) {
  res.contentType("text/plain").send(await scrapeQueue.getMetrics());
}
