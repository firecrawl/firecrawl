import { getRedisConnection } from "../../../services/queue-service";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";
import {
  nuqFdbHealthCheck,
  scrapeQueueFdb,
  withFdbTimeout,
} from "../../../services/worker/nuq-fdb";
import { fdbQueueEnabled } from "../../../services/worker/nuq-router";

const FDB_OPTIONAL_COUNT_TIMEOUT_MS = 500;

async function cclog() {
  const logger = _logger.child({
    module: "cclog",
  });

  const concurrencyByTeam = new Map<string, number>();
  const redis = getRedisConnection();
  let cursor = 0;
  do {
    const result = await redis.scan(
      cursor,
      "MATCH",
      "concurrency-limiter:*",
      "COUNT",
      100000,
    );
    cursor = parseInt(result[0], 10);
    const usable = result[1].filter(x => !x.includes("preview_"));

    logger.info("Stepped", { cursor, usable: usable.length });

    if (usable.length > 0) {
      for (const x of usable) {
        const concurrency = await redis.zrangebyscore(x, Date.now(), Infinity);
        const teamId = x.split(":")[1];
        concurrencyByTeam.set(
          teamId,
          (concurrencyByTeam.get(teamId) ?? 0) + concurrency.length,
        );
      }
    }
  } while (cursor != 0);

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
    } catch (e) {
      logger.warn("Error reading FDB concurrency", { error: e });
    }
  }

  const at = new Date();
  const entries = Array.from(concurrencyByTeam.entries()).map(
    ([team_id, concurrency]) => ({
      team_id,
      concurrency,
      created_at: at.toISOString(),
    }),
  );

  if (entries.length === 0) return;

  try {
    await db.insert(schema.concurrency_log).values(entries);
  } catch (e) {
    logger.error("Error inserting", { error: e });
  }
}

export async function cclogController(req: Request, res: Response) {
  try {
    await cclog();
    res.status(200).json({ ok: true });
  } catch (e) {
    _logger.error("Error", { module: "cclog", error: e });
    res.status(500).json({
      message: "Error",
    });
  }
}
