import { randomUUID } from "crypto";
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

const CONCURRENCY_ROLLBACK_QUEUE = "concurrency-rollback-cleanup:v1";
// Deliberately longer than every normal holder lease. The durable FDB holder
// deadline remains the recovery authority if Redis itself is lost.
export const CONCURRENCY_ROLLBACK_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY_ROLLBACK_BATCH = 100;

function concurrencyRollbackQueueMember(
  teamId: string,
  id: string,
  token: string,
): string {
  return JSON.stringify({ v: 1, teamId, id, token });
}

export const constructConcurrencyLimitKey = (team_id: string) =>
  "concurrency-limiter:" + team_id;

const constructConcurrencyReservationKey = (teamId: string, id: string) =>
  `${constructConcurrencyLimitKey(teamId)}:reservation:${id}`;

const countConcurrencySlotsScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
return redis.call('ZCARD', KEYS[1])
`;

export async function getConcurrencyLimitActiveJobsCount(
  team_id: string,
): Promise<number> {
  return (await getRedisConnection().eval(
    countConcurrencySlotsScript,
    1,
    constructConcurrencyLimitKey(team_id),
  )) as number;
}

type ConcurrencySlotReservation = {
  reserved: boolean;
  newlyAcquired: boolean;
  rollbackToken: string | null;
  cleanupToken: string | null;
};

const reserveConcurrencySlotScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', now_ms + tonumber(ARGV[3]), ARGV[1])
  if redis.call('GET', KEYS[2]) == 'owner:' .. ARGV[4] then
    redis.call('PEXPIRE', KEYS[2], ARGV[3])
    return {1, 1}
  end
  -- A distinct retry/renewal now owns the stable holder. Fence any older
  -- insertion token without granting this renewal destructive rollback rights.
  redis.call('SET', KEYS[2], 'held', 'PX', ARGV[3])
  return {1, 0}
end

local marker = redis.call('GET', KEYS[2])
if marker then
  if string.sub(marker, 1, 8) == 'cleanup:' then
    return {2, string.sub(marker, 9)}
  end
  return {0, 0}
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return {0, 0}
end

redis.call('ZADD', KEYS[1], 'NX', now_ms + tonumber(ARGV[3]), ARGV[1])
redis.call('SET', KEYS[2], 'owner:' .. ARGV[4], 'PX', ARGV[3])
return {1, 1}
`;

// The PG capacity ledger is a Redis ZSET. Admission and insertion must remain
// one server-side operation: browser/session requests may arrive concurrently.
export async function reserveConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  limit: number,
  timeout: number,
): Promise<ConcurrencySlotReservation> {
  const redis = getRedisConnection();
  const operationToken = randomUUID();
  let result: [number, number | string] | null = null;
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = (await redis.eval(
        reserveConcurrencySlotScript,
        2,
        constructConcurrencyLimitKey(team_id),
        constructConcurrencyReservationKey(team_id, id),
        id,
        limit,
        timeout,
        operationToken,
      )) as [number, number | string];
      break;
    } catch (error) {
      if (attempt === 1) {
        throw new AggregateError(
          firstError === undefined ? [error] : [firstError, error],
          "Redis concurrency reservation failed after idempotent retry",
        );
      }
      firstError = error;
    }
  }
  const [status, detail] = result!;
  const newlyAcquired = status === 1 && detail === 1;
  return {
    reserved: status === 1,
    newlyAcquired,
    rollbackToken: newlyAcquired ? operationToken : null,
    cleanupToken: status === 2 ? String(detail) : null,
  };
}

const pushConcurrencySlotScript = `
local marker = redis.call('GET', KEYS[2])
if marker and string.sub(marker, 1, 8) == 'cleanup:' then return 0 end
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('DEL', KEYS[2])
return redis.call('ZADD', KEYS[1], now_ms + tonumber(ARGV[2]), ARGV[1])
`;

export async function pushConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  timeout: number,
) {
  await getRedisConnection().eval(
    pushConcurrencySlotScript,
    2,
    constructConcurrencyLimitKey(team_id),
    constructConcurrencyReservationKey(team_id, id),
    id,
    timeout,
  );
}

const removeConcurrencySlotScript = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return 0 end
local marker = redis.call('GET', KEYS[2])
if marker and string.sub(marker, 1, 8) ~= 'cleanup:' then
  redis.call('DEL', KEYS[2])
end
return 1
`;

export async function removeConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
) {
  await getRedisConnection().eval(
    removeConcurrencySlotScript,
    2,
    constructConcurrencyLimitKey(team_id),
    constructConcurrencyReservationKey(team_id, id),
    id,
  );
}

const rollbackConcurrencySlotScript = `
if redis.call('GET', KEYS[2]) ~= 'owner:' .. ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('SET', KEYS[2], 'cleanup:' .. ARGV[2], 'PX', ARGV[4])
redis.call('ZADD', KEYS[3], now_ms, ARGV[3])
return 1
`;

export async function rollbackConcurrencyLimitActiveJob(
  teamId: string,
  id: string,
  rollbackToken: string,
  holderTtlMs = 0,
): Promise<boolean> {
  const markerTtlMs = Math.max(
    CONCURRENCY_ROLLBACK_MARKER_TTL_MS,
    holderTtlMs + 24 * 60 * 60 * 1000,
  );
  return (
    (await getRedisConnection().eval(
      rollbackConcurrencySlotScript,
      3,
      constructConcurrencyLimitKey(teamId),
      constructConcurrencyReservationKey(teamId, id),
      CONCURRENCY_ROLLBACK_QUEUE,
      id,
      rollbackToken,
      concurrencyRollbackQueueMember(teamId, id, rollbackToken),
      markerTtlMs,
    )) === 1
  );
}

const finalizeConcurrencyRollbackScript = `
if redis.call('GET', KEYS[1]) ~= 'cleanup:' .. ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

export async function finalizeConcurrencyLimitActiveJobRollback(
  teamId: string,
  id: string,
  rollbackToken: string,
): Promise<boolean> {
  return (
    (await getRedisConnection().eval(
      finalizeConcurrencyRollbackScript,
      2,
      constructConcurrencyReservationKey(teamId, id),
      CONCURRENCY_ROLLBACK_QUEUE,
      rollbackToken,
      concurrencyRollbackQueueMember(teamId, id, rollbackToken),
    )) === 1
  );
}

type ConcurrencyRollbackQueueEntry = {
  v: 1;
  teamId: string;
  id: string;
  token: string;
};

const recoverConcurrencyRollbackScript = `
local marker = redis.call('GET', KEYS[1])
if marker == 'cleanup:' .. ARGV[1] then
  redis.call('DEL', KEYS[1])
end
-- A renewal/reacquire may have replaced the marker. Never delete it, but this
-- exact old queue item is complete either way.
redis.call('ZREM', KEYS[2], ARGV[2])
return marker == 'cleanup:' .. ARGV[1] and 1 or 0
`;

/** Drains one bounded due page. It never scans Redis keyspace and exact-token
 * fencing prevents a delayed cleanup from deleting a replacement holder. */
export type ConcurrencyRollbackCleanupBacklog = {
  total: number;
  due: number;
  oldestDueAt: number | null;
  oldestOverdueMs: number;
};

const observeConcurrencyRollbackBacklogScript = `
local total = redis.call('ZCARD', KEYS[1])
local due = redis.call('ZCOUNT', KEYS[1], '-inf', ARGV[1])
local oldest = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'WITHSCORES', 'LIMIT', 0, 1)
return {total, due, oldest[2] or ''}
`;

/** Exact bounded queue observability. One atomic script uses native ZCARD and
 * ZCOUNT plus one limit-1 ordered read; it never scans the Redis keyspace. */
export async function getConcurrencyRollbackCleanupBacklog(
  now = Date.now(),
): Promise<ConcurrencyRollbackCleanupBacklog> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("rollback observation time must be nonnegative");
  }
  const result = (await getRedisConnection().eval(
    observeConcurrencyRollbackBacklogScript,
    1,
    CONCURRENCY_ROLLBACK_QUEUE,
    now,
  )) as [number, number, string];
  if (!Array.isArray(result) || result.length !== 3) {
    throw new Error("Corrupt Redis rollback cleanup accounting");
  }
  const [total, due, oldestScore] = result;
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(due) ||
    due < 0 ||
    due > total ||
    typeof oldestScore !== "string"
  ) {
    throw new Error("Corrupt Redis rollback cleanup accounting");
  }
  const oldestDueAt = oldestScore === "" ? null : Number(oldestScore);
  if (
    (due === 0) !== (oldestDueAt === null) ||
    (oldestDueAt !== null &&
      (!Number.isSafeInteger(oldestDueAt) ||
        oldestDueAt < 0 ||
        oldestDueAt > now))
  ) {
    throw new Error("Corrupt Redis rollback cleanup oldest score");
  }
  return {
    total,
    due,
    oldestDueAt,
    oldestOverdueMs: oldestDueAt === null ? 0 : Math.max(0, now - oldestDueAt),
  };
}

export async function recoverConcurrencyLimitRollbacks(
  limit = CONCURRENCY_ROLLBACK_BATCH,
): Promise<{
  read: number;
  finalized: number;
  fenced: number;
  hasMore: boolean;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError("rollback recovery limit must be between 1 and 1000");
  }
  const redis = getRedisConnection();
  const now = Date.now();
  const members = await redis.zrangebyscore(
    CONCURRENCY_ROLLBACK_QUEUE,
    "-inf",
    now,
    "LIMIT",
    0,
    limit,
  );
  let finalized = 0;
  let fenced = 0;
  for (const member of members) {
    let entry: ConcurrencyRollbackQueueEntry | null = null;
    try {
      const decoded = JSON.parse(
        member,
      ) as Partial<ConcurrencyRollbackQueueEntry>;
      if (
        decoded.v === 1 &&
        typeof decoded.teamId === "string" &&
        decoded.teamId.length > 0 &&
        typeof decoded.id === "string" &&
        decoded.id.length > 0 &&
        typeof decoded.token === "string" &&
        decoded.token.length > 0
      ) {
        entry = decoded as ConcurrencyRollbackQueueEntry;
      }
    } catch {
      // Corrupt queue entries carry no authority.
    }
    if (!entry) {
      await redis.zrem(CONCURRENCY_ROLLBACK_QUEUE, member);
      fenced++;
      continue;
    }
    const removed = await redis.eval(
      recoverConcurrencyRollbackScript,
      2,
      constructConcurrencyReservationKey(entry.teamId, entry.id),
      CONCURRENCY_ROLLBACK_QUEUE,
      entry.token,
      member,
    );
    if (removed === 1) finalized++;
    else fenced++;
  }
  return {
    read: members.length,
    finalized,
    fenced,
    hasMore: members.length === limit,
  };
}

const renewConcurrencySlotScript = `
local t = redis.call('TIME')
local now_ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], 'XX', now_ms + tonumber(ARGV[2]), ARGV[1])
-- Heartbeat renewal fences a delayed rollback from the original insertion.
redis.call('SET', KEYS[2], 'held', 'PX', ARGV[2])
return 1
`;

export async function renewConcurrencyLimitActiveJob(
  teamId: string,
  id: string,
  timeout: number,
): Promise<boolean> {
  return (
    (await getRedisConnection().eval(
      renewConcurrencySlotScript,
      2,
      constructConcurrencyLimitKey(teamId),
      constructConcurrencyReservationKey(teamId, id),
      id,
      timeout,
    )) === 1
  );
}
