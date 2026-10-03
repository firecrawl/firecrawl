import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { redisEvictConnection } from "../redis";

const logger = _logger.child({ module: "in-app-notification" });

// Outlives queue redelivery of the job that produced the notification.
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

// Must match a type firecrawl-web's notification registry knows how to render.
type InAppNotificationType =
  | "monitorChangeDetected"
  | "crawlCompleted"
  | "batchScrapeCompleted";

/**
 * Add a row to the team's dashboard notification center. Never throws: a
 * missing notification must not fail the job that produced it. With a
 * `dedupeKey`, only the first call per key and type writes a row.
 */
export async function createInAppNotification(
  teamId: string,
  type: InAppNotificationType,
  metadata: Record<string, string | number | null>,
  options: { dedupeKey?: string } = {},
): Promise<boolean> {
  // Self-hosted deployments have no dashboard to show these in.
  if (!config.USE_DB_AUTHENTICATION) return false;
  const claimKey = options.dedupeKey
    ? `in-app-notification:${type}:${options.dedupeKey}`
    : null;
  let claimed = false;
  try {
    if (claimKey) {
      const result = await redisEvictConnection.set(
        claimKey,
        "1",
        "EX",
        DEDUPE_TTL_SECONDS,
        "NX",
      );
      if (result !== "OK") return false;
      claimed = true;
    }
    const now = new Date().toISOString();
    await db.insert(schema.user_notifications).values({
      team_id: teamId,
      notification_type: type,
      sent_date: now,
      timestamp: now,
      metadata,
    });
    return true;
  } catch (error) {
    logger.warn("Failed to create in-app notification", {
      error,
      teamId,
      type,
    });
    if (claimed && claimKey) {
      // Let a redelivered job retry the write.
      await redisEvictConnection.del(claimKey).catch(() => {});
    }
    return false;
  }
}

/** Jobs started from the dashboard playground send origin "website". */
export function isDashboardOrigin(origin: unknown): boolean {
  return origin === "website";
}
