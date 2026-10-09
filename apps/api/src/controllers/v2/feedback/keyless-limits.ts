import { config } from "../../../config";
import { redisRateLimitClient } from "../../../services/rate-limiter";

const KEYLESS_FEEDBACK_ATTEMPTS = 30;
const KEYLESS_FEEDBACK_MIN_DAILY_ATTEMPTS = 300;
const keylessFeedbackAttemptKey = (identity: string) =>
  `keyless_feedback_attempts:${identity}`;
const keylessFeedbackDailyAttemptKey = (identity: string) =>
  `keyless_feedback_attempts_day:${identity}`;

export async function consumeKeylessFeedbackAttempt(
  identity: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const dailyLimit = Math.max(
    KEYLESS_FEEDBACK_MIN_DAILY_ATTEMPTS,
    (config.KEYLESS_REQUESTS_PER_DAY ?? 0) * 3,
  );
  const [allowed, retryAfterSeconds] = (await redisRateLimitClient.eval(
    `
local minute = redis.call('INCR', KEYS[1])
if minute == 1 then redis.call('EXPIRE', KEYS[1], 60) end
local day = redis.call('INCR', KEYS[2])
if day == 1 then redis.call('EXPIRE', KEYS[2], 86400) end
if day > tonumber(ARGV[2]) then return {0, redis.call('TTL', KEYS[2])} end
if minute > tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
return {1, 0}
`,
    2,
    keylessFeedbackAttemptKey(identity),
    keylessFeedbackDailyAttemptKey(identity),
    KEYLESS_FEEDBACK_ATTEMPTS,
    dailyLimit,
  )) as [number, number];
  return {
    allowed: allowed === 1,
    retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, retryAfterSeconds),
  };
}

export const KEYLESS_FEEDBACK_MAX_AGE_SEC = 86400;
export const KEYLESS_FEEDBACK_MAX_FUTURE_SKEW_SEC = 300;
