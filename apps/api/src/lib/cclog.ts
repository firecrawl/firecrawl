import type IORedis from "ioredis";
import { logger as _logger } from "./logger";
import {
  nuqFdbHealthCheck,
  scrapeQueueFdb,
  withFdbTimeout,
} from "../services/worker/nuq-fdb";
import { fdbQueueEnabled } from "../services/worker/nuq-router";
import { chInsert } from "./clickhouse-client";

const FDB_OPTIONAL_COUNT_TIMEOUT_MS = 500;
const CONCURRENCY_LIMITER_KEY_PATTERN = "concurrency-limiter:*";
const PREVIEW_KEY_FRAGMENT = "preview_";
const CCLOG_SAMPLE_KEY_PREFIX = "cclog:minute";
const CCLOG_SAMPLE_TTL_SECONDS = 60 * 60;

const CCLOG_MINUTE_MS = 60 * 1000;
const CCLOG_AGGREGATE_INTERVAL_MINUTES = 10;

// Dragonfly rejects commands with more than 2^16 arguments ("invalid
// multibulk length") and drops the connection, so a single HSET silently
// fails once a sample holds ~32k+ teams. Chunk well below that limit.
const CCLOG_HSET_FIELD_CHUNK_SIZE = 16000;

type CclogSample = {
  at: Date;
  concurrencyByTeam: Map<string, number>;
};

type CclogAggregateEntry = {
  team_id: string;
  avg_concurrency: number;
  max_concurrency: number;
  created_at: string;
};

export function floorToMinute(date: Date): Date {
  const at = new Date(date);
  at.setSeconds(0, 0);
  return at;
}

export function getMsUntilNextMinute(now = new Date()): number {
  return CCLOG_MINUTE_MS - (now.getSeconds() * 1000 + now.getMilliseconds());
}

function getSampleKey(at: Date): string {
  return `${CCLOG_SAMPLE_KEY_PREFIX}:${Math.floor(
    floorToMinute(at).getTime() / CCLOG_MINUTE_MS,
  )}`;
}

function shouldAggregateAt(at: Date): boolean {
  return (
    floorToMinute(at).getMinutes() % CCLOG_AGGREGATE_INTERVAL_MINUTES === 0
  );
}

function getAggregationWindow(at: Date): Date[] {
  const end = floorToMinute(at).getTime();
  return Array.from({ length: CCLOG_AGGREGATE_INTERVAL_MINUTES }, (_, i) => {
    return new Date(
      end - (CCLOG_AGGREGATE_INTERVAL_MINUTES - 1 - i) * CCLOG_MINUTE_MS,
    );
  });
}

async function collectCurrentConcurrency(
  redis: IORedis,
): Promise<Map<string, number>> {
  const logger = _logger.child({ module: "cclog" });
  const concurrencyByTeam = new Map<string, number>();

  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      CONCURRENCY_LIMITER_KEY_PATTERN,
      "COUNT",
      100000,
    );
    cursor = nextCursor;

    const usable = keys.filter(x => !x.includes(PREVIEW_KEY_FRAGMENT));
    logger.info("Scanned concurrency limiter keys", {
      cursor,
      usable: usable.length,
    });

    for (const key of usable) {
      const concurrency = await redis.zrangebyscore(key, Date.now(), Infinity);
      const teamId = key.split(":")[1];

      if (!teamId) continue;

      concurrencyByTeam.set(
        teamId,
        (concurrencyByTeam.get(teamId) ?? 0) + concurrency.length,
      );
    }
  } while (cursor !== "0");

  if (fdbQueueEnabled()) {
    try {
      if (await nuqFdbHealthCheck(FDB_OPTIONAL_COUNT_TIMEOUT_MS)) {
        const fdbCounts = await withFdbTimeout(
          scrapeQueueFdb.getTeamActiveCounts(),
          FDB_OPTIONAL_COUNT_TIMEOUT_MS,
        );

        for (const [teamId, concurrency] of fdbCounts) {
          concurrencyByTeam.set(
            teamId,
            (concurrencyByTeam.get(teamId) ?? 0) + concurrency,
          );
        }
      }
    } catch (error) {
      logger.warn("Error reading FDB concurrency", { error });
    }
  }

  return concurrencyByTeam;
}

async function saveCclogMinuteSample(
  redis: IORedis,
  sample: CclogSample,
): Promise<void> {
  const key = getSampleKey(sample.at);
  const pipeline = redis.pipeline();

  if (sample.concurrencyByTeam.size > 0) {
    let values: Record<string, string> = {};

    for (const [teamId, concurrency] of sample.concurrencyByTeam) {
      values[teamId] = String(concurrency);

      if (Object.keys(values).length >= CCLOG_HSET_FIELD_CHUNK_SIZE) {
        pipeline.hset(key, values);
        values = {};
      }
    }

    if (Object.keys(values).length > 0) {
      pipeline.hset(key, values);
    }
  } else {
    pipeline.hset(key, "__empty__", "0");
  }

  pipeline.expire(key, CCLOG_SAMPLE_TTL_SECONDS);

  const results = await pipeline.exec();
  const error = (results ?? []).find(([err]) => err)?.[0];
  if (error) {
    throw new Error(`Failed to save cclog minute sample: ${error.message}`);
  }
}

async function buildCclogAggregateEntries(
  redis: IORedis,
  at: Date,
): Promise<CclogAggregateEntry[]> {
  const window = getAggregationWindow(at);
  const samples = await Promise.all(
    window.map(async minute => {
      const values = await redis.hgetall(getSampleKey(minute));
      delete values.__empty__;
      return values;
    }),
  );

  const teamIds = new Set<string>();
  for (const sample of samples) {
    for (const teamId of Object.keys(sample)) {
      teamIds.add(teamId);
    }
  }

  const created_at = floorToMinute(at).toISOString();
  const entries: CclogAggregateEntry[] = [];

  for (const team_id of teamIds) {
    let total = 0;
    let maxConcurrency = 0;

    for (const sample of samples) {
      const concurrency = Number.parseInt(sample[team_id] ?? "0", 10);
      total += concurrency;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
    }

    const avgConcurrency = Math.round(total / CCLOG_AGGREGATE_INTERVAL_MINUTES);
    if (avgConcurrency === 0 && maxConcurrency === 0) {
      continue;
    }

    entries.push({
      team_id,
      avg_concurrency: avgConcurrency,
      max_concurrency: maxConcurrency,
      created_at,
    });
  }

  return entries;
}

async function insertCclogAggregate(
  entries: CclogAggregateEntry[],
): Promise<boolean> {
  if (entries.length === 0) return true;

  return chInsert("concurrency_logs", entries, { throwOnError: true });
}

export async function runCclogTick(redis: IORedis, at = new Date()) {
  const logger = _logger.child({ module: "cclog" });
  const minute = floorToMinute(at);
  const concurrencyByTeam = await collectCurrentConcurrency(redis);

  await saveCclogMinuteSample(redis, {
    at: minute,
    concurrencyByTeam,
  });

  logger.info("Saved cclog minute sample", {
    at: minute.toISOString(),
    teams: concurrencyByTeam.size,
  });

  if (!shouldAggregateAt(minute)) {
    return {
      sampledTeams: concurrencyByTeam.size,
      insertedRows: 0,
    };
  }

  const entries = await buildCclogAggregateEntries(redis, minute);
  let insertedRows = 0;

  try {
    if (await insertCclogAggregate(entries)) {
      insertedRows = entries.length;
      logger.info("Inserted cclog aggregate", {
        at: minute.toISOString(),
        rows: insertedRows,
      });
    } else {
      logger.warn("Skipped cclog aggregate insert", {
        at: minute.toISOString(),
        rows: entries.length,
      });
    }
  } catch (error) {
    logger.error("Error inserting cclog aggregate", { error });
  }

  return {
    sampledTeams: concurrencyByTeam.size,
    insertedRows,
  };
}
