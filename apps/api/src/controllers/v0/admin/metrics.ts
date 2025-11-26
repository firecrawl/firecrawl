import type { Request, Response } from "express";
import { getRedisConnection } from "../../../services/queue-service";
import { nuqGetLocalMetrics, scrapeQueue } from "../../../services/worker/nuq";
import { teamConcurrencySemaphore } from "../../../services/worker/team-semaphore";

export async function metricsController(_: Request, res: Response) {
  let cursor: string = "0";
  const metrics: Record<string, number> = {};
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
        const teamId = key.split(":")[1];
        metrics[teamId] = jobCount;
      }
    }
  } while (cursor !== "0");

  const semaphoreMetrics = await teamConcurrencySemaphore.getMetrics();

  res.contentType("text/plain").send(`\
# HELP concurrency_limit_queue_job_count The number of jobs in the concurrency limit queue per team
# TYPE concurrency_limit_queue_job_count gauge
${Object.entries(metrics)
  .map(
    ([key, value]) =>
      `concurrency_limit_queue_job_count{team_id="${key}"} ${value}`,
  )
  .join("\n")}

# HELP billed_teams_count The number of teams that have been billed but not yet tallied
# TYPE billed_teams_count gauge
billed_teams_count ${await getRedisConnection().scard("billed_teams")}

${nuqGetLocalMetrics()}
${semaphoreMetrics}`);
}

export async function nuqMetricsController(_: Request, res: Response) {
  res.contentType("text/plain").send(await scrapeQueue.getMetrics());
}
