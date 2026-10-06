import { config } from "../config";
import { redisRateLimitClient } from "../services/rate-limiter";
import { logger } from "./logger";

const activityKey = (teamId: string) => `alexandria:activity:${teamId}`;

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
