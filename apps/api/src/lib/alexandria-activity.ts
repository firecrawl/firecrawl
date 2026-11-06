import { config } from "../config";
import { redisRateLimitClient } from "../services/rate-limiter";
import { logger } from "./logger";

const activityKey = (teamId: string) => `alexandria:activity:${teamId}`;
const recentCallsKey = (teamId: string) => `alexandria:calls:${teamId}`;
const RECENT_CALLS_LIMIT = 20;

export type AlexandriaCall = {
  requestId: string;
  provider: string;
  capability: string;
};
export type RecentAlexandriaCall = AlexandriaCall & { at: number };

/**
 * Opens (or extends) the team's Alexandria feedback window for
 * ALEXANDRIA_FEEDBACK_WINDOW_SEC. Never rejects; a failed write is only logged.
 */
export async function recordAlexandriaActivity(teamId: string): Promise<void> {
  try {
    await redisRateLimitClient.set(
      activityKey(teamId),
      "1",
      "EX",
      config.ALEXANDRIA_FEEDBACK_WINDOW_SEC,
    );
  } catch (error) {
    logger.warn("Failed to record Alexandria activity", { error, teamId });
  }
}

/** Fire-and-forget form of recordAlexandriaActivity for latency-sensitive paths. */
export function markAlexandriaActivity(teamId: string): void {
  void recordAlexandriaActivity(teamId);
}

/** Whether the team used Alexandria within the feedback window. */
export async function hasRecentAlexandriaActivity(
  teamId: string,
): Promise<boolean> {
  return (await redisRateLimitClient.exists(activityKey(teamId))) === 1;
}

/**
 * Prepends provider calls to the team's recent-call list (newest first, capped
 * at RECENT_CALLS_LIMIT, same TTL as the feedback window). Never rejects.
 * Callers must skip this under zero data retention.
 */
export async function recordAlexandriaCalls(
  teamId: string,
  calls: AlexandriaCall[],
): Promise<void> {
  if (calls.length === 0) return;
  const at = Date.now();
  const key = recentCallsKey(teamId);
  try {
    const results = await redisRateLimitClient
      .multi()
      .lpush(
        key,
        ...calls.map(({ requestId, provider, capability }) =>
          JSON.stringify({ requestId, provider, capability, at }),
        ),
      )
      .ltrim(key, 0, RECENT_CALLS_LIMIT - 1)
      .expire(key, config.ALEXANDRIA_FEEDBACK_WINDOW_SEC)
      .exec();
    const commandError = results?.find(([error]) => error)?.[0];
    if (commandError) throw commandError;
  } catch (error) {
    logger.warn("Failed to record Alexandria calls", { error, teamId });
  }
}

/** Fire-and-forget form of recordAlexandriaCalls. */
export function markAlexandriaCalls(
  teamId: string,
  calls: AlexandriaCall[],
): void {
  void recordAlexandriaCalls(teamId, calls);
}

/** The team's recent provider calls, newest first. Never rejects; returns [] on failure. */
export async function getRecentAlexandriaCalls(
  teamId: string,
): Promise<RecentAlexandriaCall[]> {
  let raw: string[];
  try {
    raw = await redisRateLimitClient.lrange(
      recentCallsKey(teamId),
      0,
      RECENT_CALLS_LIMIT - 1,
    );
  } catch (error) {
    logger.warn("Failed to read recent Alexandria calls", { error, teamId });
    return [];
  }
  return raw.flatMap(entry => {
    try {
      const value = JSON.parse(entry);
      return typeof value?.requestId === "string" &&
        typeof value.provider === "string" &&
        typeof value.capability === "string" &&
        typeof value.at === "number"
        ? [
            {
              requestId: value.requestId,
              provider: value.provider,
              capability: value.capability,
              at: value.at,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}
