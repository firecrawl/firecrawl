import { getRedisConnection } from "../services/queue-service";

// Redis primitives of the concurrency limiter, split out of
// concurrency-limit.ts so light consumers (the NuQ dual-backend router) can
// use them without dragging in the scraper tree via crawl-redis.

// min 50k, max 2M, 2000 per concurrent browser
export function getTeamQueueLimit(concurrencyLimit: number): number {
  return Math.min(Math.max(concurrencyLimit * 2000, 50_000), 2_000_000);
}

// Upper bound for how long a job may sit in the concurrency-limit backlog.
// This bounds both the Redis ZSET score and the Postgres `times_out_at`
// column on `nuq.queue_scrape_backlog`, so the reaper can always evict
// stale rows. A backlogged crawl job that outlives this window is
// unrecoverable anyway — its StoredCrawl in Redis (24h TTL) is gone.
export const MAX_BACKLOG_TIMEOUT_MS = 172800000; // 48h

export const constructConcurrencyLimitKey = (team_id: string) =>
  "concurrency-limiter:" + team_id;

export async function getConcurrencyLimitActiveJobsCount(
  team_id: string,
): Promise<number> {
  return await getRedisConnection().zcount(
    constructConcurrencyLimitKey(team_id),
    Date.now(),
    Infinity,
  );
}

export async function pushConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  timeout: number,
  now: number = Date.now(),
) {
  await getRedisConnection().zadd(
    constructConcurrencyLimitKey(team_id),
    now + timeout,
    id,
  );
}

export async function removeConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
) {
  await getRedisConnection().zrem(constructConcurrencyLimitKey(team_id), id);
}
