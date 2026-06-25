import "dotenv/config";
import { config } from "../config";
import "./sentry";
import { setSentryServiceTag } from "./sentry";
import Express from "express";
import { logger as _logger } from "../lib/logger";
import {
  floorToMinute,
  getMsUntilNextMinute,
  runCclogTick,
} from "../lib/cclog";
import { getRedisConnection } from "./queue-service";

const CCLOG_WORKER_LOCK_KEY = "cclog:worker:tick-lock";
const CCLOG_WORKER_LOCK_TTL_SECONDS = 55;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  setSentryServiceTag("cclog-worker");

  let isShuttingDown = false;
  let tickInFlight = false;

  const app = Express();
  app.get("/health", (_, res) => {
    res.status(200).send("OK");
  });

  const server = app.listen(config.CCLOG_WORKER_PORT, (error?: Error) => {
    if (error) {
      _logger.error("Failed to start cclog worker", {
        error,
        port: config.CCLOG_WORKER_PORT,
      });
      throw error;
    }

    _logger.info("cclog worker started", {
      port: config.CCLOG_WORKER_PORT,
    });
  });

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    _logger.info("cclog worker shutting down");

    while (tickInFlight) {
      _logger.info("Waiting for in-flight cclog tick to complete...");
      await sleep(1000);
    }

    server.close(() => {
      _logger.info("cclog worker shut down");
      process.exit(0);
    });
  }

  if (require.main === module) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  _logger.info("Waiting for next exact minute to start cclog worker", {
    waitMs: getMsUntilNextMinute(),
  });
  await sleep(getMsUntilNextMinute());

  const redis = getRedisConnection();

  while (!isShuttingDown) {
    const at = floorToMinute(new Date());
    tickInFlight = true;

    try {
      const lock = await redis.set(
        CCLOG_WORKER_LOCK_KEY,
        `${process.pid}:${at.toISOString()}`,
        "EX",
        CCLOG_WORKER_LOCK_TTL_SECONDS,
        "NX",
      );

      if (lock === "OK") {
        const summary = await runCclogTick(redis, at);
        _logger.info("cclog tick complete", {
          at: at.toISOString(),
          ...summary,
        });
      } else {
        _logger.info("Skipping cclog tick because another worker holds lock", {
          at: at.toISOString(),
        });
      }
    } catch (error) {
      _logger.error("cclog tick failed", { error });
    } finally {
      tickInFlight = false;
    }

    if (!isShuttingDown) {
      await sleep(getMsUntilNextMinute());
    }
  }
})();
