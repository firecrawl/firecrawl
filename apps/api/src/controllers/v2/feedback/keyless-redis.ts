import Redis from "ioredis";
import { config } from "../../../config";
import { logger } from "../../../lib/logger";

export function feedbackRedisUrl(feedbackUrl?: string, rateLimitUrl?: string) {
  if (!feedbackUrl) return undefined;
  const address = (value: string) => {
    const url = new URL(value);
    const host = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? "loopback"
      : url.hostname.toLowerCase();
    return `${host}:${url.port || "6379"}`;
  };
  try {
    address(feedbackUrl);
    if (rateLimitUrl && address(feedbackUrl) === address(rateLimitUrl))
      return undefined;
  } catch {
    return undefined;
  }
  return feedbackUrl;
}

// A different logical database on the same server does not isolate memory.
const url = feedbackRedisUrl(
  config.KEYLESS_FEEDBACK_REDIS_URL,
  config.REDIS_RATE_LIMIT_URL,
);
if (config.KEYLESS_FEEDBACK_REDIS_URL && !url) {
  logger.warn(
    "Keyless feedback requires a valid Redis URL on a separate server",
    {
      canonicalLog: "keyless/feedback_cache_configuration_error",
    },
  );
}
export const keylessFeedbackRedis = url
  ? new Redis(url, {
      enableAutoPipelining: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 200,
      connectTimeout: 1000,
    })
  : null;

keylessFeedbackRedis?.on("error", () => {
  logger.warn("Keyless feedback cache unavailable", {
    canonicalLog: "keyless/feedback_cache_error",
  });
});
