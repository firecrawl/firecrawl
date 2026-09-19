import { redisRateLimitClient } from "../../../services/rate-limiter";

const KEYLESS_FEEDBACK_ATTEMPTS = 30;
const keylessFeedbackAttemptKey = (identity: string) =>
  `keyless_feedback_attempts:${identity}`;

export async function consumeKeylessFeedbackAttempt(identity: string) {
  const count = Number(
    await redisRateLimitClient.eval(
      `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return count
`,
      1,
      keylessFeedbackAttemptKey(identity),
    ),
  );
  return count <= KEYLESS_FEEDBACK_ATTEMPTS;
}

export const KEYLESS_FEEDBACK_MAX_AGE_SEC = 86400;
