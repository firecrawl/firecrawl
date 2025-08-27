import IORedis from "ioredis";
import { redisRateLimitClient } from "./rate-limiter";
import { logger } from "../lib/logger";

// Listen to 'error' events to the Redis connection
redisRateLimitClient.on("error", (error) => {
  try {
    if (error.message === "ECONNRESET") {
      logger.error("Connection to Redis Session Rate Limit Store timed out.");
    } else if (error.message === "ECONNREFUSED") {
      logger.error("Connection to Redis Session Rate Limit Store refused!");
    } else logger.error(error);
  } catch (error) {}
});

// Listen to 'reconnecting' event to Redis
redisRateLimitClient.on("reconnecting", (err) => {
  try {
    if (redisRateLimitClient.status === "reconnecting")
      logger.info("Reconnecting to Redis Session Rate Limit Store...");
    else logger.error("Error reconnecting to Redis Session Rate Limit Store.");
  } catch (error) {}
});

// Listen to the 'connect' event to Redis
redisRateLimitClient.on("connect", (err) => {
  try {
    if (!err) logger.info("Connected to Redis Session Rate Limit Store!");
  } catch (error) {}
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

const redisEvictURL = process.env.REDIS_EVICT_URL ?? process.env.REDIS_RATE_LIMIT_URL;
export const redisEvictConnection = new IORedis(redisEvictURL!);
