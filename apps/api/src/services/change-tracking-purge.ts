import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { Counter } from "prom-client";
import { config } from "../config";
import { db } from "../db/connection";
import { teams } from "../db/schema";
import { changeTrackingDeleteTeam } from "../lib/change-tracking-store";
import { logger as _logger } from "../lib/logger";
import {
  getChangeTrackingPurgeQueue,
  type ChangeTrackingPurgeJobData,
} from "./queue-service";

const logger = _logger.child({ module: "change-tracking-purge" });

// The first pass runs once the dashboard has deleted the team row. The second
// catches rows written afterwards by jobs that were already running for the
// team, which crawls do for up to a day.
const PASS_DELAYS_MS = [30 * 1000, 25 * 60 * 60 * 1000];

// Exponential from one minute: twelve attempts span about 34 hours.
const PURGE_ATTEMPTS = 12;
const PURGE_BACKOFF_MS = 60 * 1000;

/**
 * - `purged`: the pass deleted every row it found.
 * - `team_exists` / `failed`: the team row is still there, or a read or delete
 *   failed. The job retries.
 * - `abandoned`: the team row outlived every attempt, so its deletion never
 *   happened and nothing was deleted.
 * - `exhausted`: the last attempt failed. The team's rows may remain; the job
 *   stays in the failed set to retry.
 */
const changeTrackingPurgeTotal = new Counter({
  name: "firecrawl_change_tracking_purge_total",
  help: "Change tracking purge runs for deleted teams, by outcome",
  labelNames: ["outcome"] as const,
});

/** Change tracking rows exist only where both of these are configured. */
export function changeTrackingPurgeConfigured(): boolean {
  return !!(config.USE_DB_AUTHENTICATION && config.BIGTABLE_INSTANCE_ID);
}

/**
 * Durably schedules both purge passes for a team. Call it before deleting the
 * team row, so a failure here can still stop the deletion; a pass retries
 * while the row exists and never deletes rows of a live team. Enqueuing again
 * while a pass is pending is a no-op for that pass; once it has finished, a new
 * enqueue schedules it again.
 */
export async function enqueueChangeTrackingPurge(
  teamId: string,
): Promise<void> {
  await getChangeTrackingPurgeQueue().addBulk(
    PASS_DELAYS_MS.map((delay, pass) => ({
      name: "purge",
      data: { teamId },
      opts: {
        delay,
        attempts: PURGE_ATTEMPTS,
        backoff: { type: "exponential", delay: PURGE_BACKOFF_MS },
        deduplication: { id: `change-tracking-purge:${teamId}:${pass}` },
      },
    })),
  );
}

export async function processChangeTrackingPurge(
  job: Job<ChangeTrackingPurgeJobData>,
): Promise<void> {
  const { teamId } = job.data;
  const attempt = job.attemptsMade + 1;
  const attempts = job.opts.attempts ?? 1;
  const last = attempt >= attempts;
  const context = { teamId, jobId: job.id, attempt, attempts };

  let teamExists: boolean;
  let deleted = 0;
  try {
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    teamExists = !!team;
    if (!teamExists) {
      deleted = await changeTrackingDeleteTeam(teamId);
    }
  } catch (error) {
    changeTrackingPurgeTotal.labels(last ? "exhausted" : "failed").inc();
    if (last) {
      logger.error(
        "Change tracking purge exhausted its attempts; the team's rows may remain",
        { ...context, error },
      );
    } else {
      logger.warn("Change tracking purge failed; will retry", {
        ...context,
        error,
      });
    }
    throw error;
  }

  if (teamExists) {
    changeTrackingPurgeTotal.labels(last ? "abandoned" : "team_exists").inc();
    logger.warn(
      last
        ? "Team still exists after every purge attempt; its deletion did not complete"
        : "Team still exists; will retry the change tracking purge",
      context,
    );
    throw new Error("Team still exists; its change tracking rows are kept");
  }

  changeTrackingPurgeTotal.labels("purged").inc();
  logger.info("Purged change tracking rows of a deleted team", {
    ...context,
    deleted,
  });
}
