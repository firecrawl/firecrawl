import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

const logger = _logger.child({ module: "in-app-notification" });

// Must match a type firecrawl-web's notification registry knows how to render.
type InAppNotificationType =
  | "monitorChangeDetected"
  | "crawlCompleted"
  | "batchScrapeCompleted";

/**
 * Add a row to the team's dashboard notification center. Never throws: a
 * missing notification must not fail the job that produced it.
 */
export async function createInAppNotification(
  teamId: string,
  type: InAppNotificationType,
  metadata: Record<string, string | number | null>,
): Promise<boolean> {
  // Self-hosted deployments have no dashboard to show these in.
  if (!config.USE_DB_AUTHENTICATION) return false;
  try {
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
    return false;
  }
}

/** Jobs started from the dashboard playground send origin "website". */
export function isDashboardOrigin(origin: unknown): boolean {
  return typeof origin === "string" && origin.includes("website");
}
