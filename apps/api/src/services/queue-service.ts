import { Queue } from "bullmq";
import { config } from "../config";
import { logger } from "../lib/logger";
import IORedis from "ioredis";

let precrawlQueue: Queue;
let redisConnection: IORedis;

export function getRedisConnection(): IORedis {
  if (!redisConnection) {
    redisConnection = new IORedis(config.REDIS_URL!, {
      maxRetriesPerRequest: null,
    });
    redisConnection.on("connect", () => logger.info("Redis connected"));
    redisConnection.on("reconnecting", () => logger.warn("Redis reconnecting"));
    redisConnection.on("error", err => logger.warn("Redis error", { err }));
  }
  return redisConnection;
}

export const precrawlQueueName = "{precrawlQueue}";

export function getPrecrawlQueue() {
  if (!precrawlQueue) {
    precrawlQueue = new Queue(precrawlQueueName, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: {
          age: 24 * 60 * 60, // 1 day
        },
        removeOnFail: {
          age: 24 * 60 * 60, // 1 day
        },
      },
    });
  }
  return precrawlQueue;
}
