import IORedis from "ioredis";
import { config } from "../config";
import { logger } from "../lib/logger";

function createRedisClient(url: string | undefined): IORedis {
  const options = {
    lazyConnect: true,
    enableAutoPipelining: true,
  };
  return url ? new IORedis(url, options) : new IORedis(options);
}

export const redisRateLimitClient = createRedisClient(
  config.REDIS_RATE_LIMIT_URL,
);

// Listen to 'error' events to the Redis connection
redisRateLimitClient.on("error", error => {
  try {
    if (error.message === "ECONNRESET") {
      logger.error("Connection to Redis Session Rate Limit Store timed out.");
    } else if (error.message === "ECONNREFUSED") {
      logger.error("Connection to Redis Session Rate Limit Store refused!");
    } else {
      logger.error(error);
    }
  } catch {
    // Ignore logging failures in Redis lifecycle listeners.
  }
});

// Listen to 'reconnecting' event to Redis
redisRateLimitClient.on("reconnecting", () => {
  try {
    if (redisRateLimitClient.status === "reconnecting") {
      logger.info("Reconnecting to Redis Session Rate Limit Store...");
    } else {
      logger.error("Error reconnecting to Redis Session Rate Limit Store.");
    }
  } catch {
    // Ignore logging failures in Redis lifecycle listeners.
  }
});

// Listen to the 'connect' event to Redis
redisRateLimitClient.on("connect", (err?: unknown) => {
  try {
    if (!err) {
      logger.info("Connected to Redis Session Rate Limit Store!");
    }
  } catch {
    // Ignore logging failures in Redis lifecycle listeners.
  }
});

/**
 * Set a value in Redis with an optional expiration time.
 * @param {string} key The key under which to store the value.
 * @param {string} value The value to store.
 * @param {number} [expire] Optional expiration time in seconds.
 */
const setValue = async (
  key: string,
  value: string,
  expire?: number,
  nx = false,
) => {
  if (expire && !nx) {
    await redisRateLimitClient.set(key, value, "EX", expire);
  } else {
    await redisRateLimitClient.set(key, value);
  }
  if (expire && nx) {
    await redisRateLimitClient.expire(key, expire, "NX");
  }
};

/**
 * Get a value from Redis.
 * @param {string} key The key of the value to retrieve.
 * @returns {Promise<string|null>} The value, if found, otherwise null.
 */
const getValue = async (key: string): Promise<string | null> => {
  const value = await redisRateLimitClient.get(key);
  return value;
};

/**
 * Delete a key from Redis.
 * @param {string} key The key to delete.
 */
const deleteKey = async (key: string) => {
  await redisRateLimitClient.del(key);
};

export { setValue, getValue, deleteKey };

const redisEvictURL = config.REDIS_EVICT_URL ?? config.REDIS_RATE_LIMIT_URL;
export const redisEvictConnection = createRedisClient(redisEvictURL);

const redisCrawlStateURL = config.REDIS_CRAWL_STATE_URL || redisEvictURL;

function crawlStateConnection(url: string | undefined): IORedis {
  if (url === redisEvictURL) {
    return redisEvictConnection;
  }
  return createRedisClient(url);
}

/** Store for crawl and batch scrape state. It must not evict live keys. */
export const redisCrawlStateConnection =
  crawlStateConnection(redisCrawlStateURL);

/**
 * Previous crawl state store, read while REDIS_CRAWL_STATE_URL moves to a new
 * store so crawls already running on the old one keep their state.
 */
export const redisCrawlStateFallbackConnection: IORedis | null =
  config.REDIS_CRAWL_STATE_FALLBACK_URL &&
  config.REDIS_CRAWL_STATE_FALLBACK_URL !== redisCrawlStateURL
    ? crawlStateConnection(config.REDIS_CRAWL_STATE_FALLBACK_URL)
    : null;
